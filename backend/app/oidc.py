"""
OIDC client logic.

Discovery-driven (issuer/.well-known/openid-configuration). Supports both
confidential (Authorization Code + client_secret) and public (Authorization
Code + PKCE, S256) clients. No client_secret is ever used for public clients.

All token requests happen server-side only.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Dict, Optional
from urllib.parse import urlencode, urlparse

import httpx

from .config import OidcConfig


class OidcError(RuntimeError):
    pass


@dataclass
class Discovery:
    authorization_endpoint: str = ""
    token_endpoint: str = ""
    userinfo_endpoint: str = ""
    end_session_endpoint: str = ""
    jwks_uri: str = ""
    issuer: str = ""
    fetched_at: float = 0.0


@dataclass
class TokenSet:
    access_token: str = ""
    id_token: str = ""
    refresh_token: str = ""
    token_type: str = "Bearer"
    expires_in: int = 0
    obtained_at: float = field(default_factory=time.time)
    raw: Dict = field(default_factory=dict)

    def access_token_expired(self, skew: int = 30) -> bool:
        if not self.expires_in:
            return False
        return time.time() >= self.obtained_at + self.expires_in - skew

    @property
    def expires_at(self) -> float:
        return self.obtained_at + self.expires_in


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def gen_code_verifier() -> str:
    # 43-128 chars, url-safe
    return _b64url(secrets.token_bytes(64))[:96]


def code_challenge(verifier: str) -> str:
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def gen_state() -> str:
    return secrets.token_urlsafe(32)


class OidcClient:
    def __init__(self, cfg: OidcConfig) -> None:
        self.cfg = cfg
        self._discovery: Optional[Discovery] = None
        self._discovery_lock = __import__("threading").Lock()

    # ---- discovery --------------------------------------------------
    def discovery(self, force: bool = False) -> Discovery:
        if not self.cfg.issuer:
            raise OidcError("oidc.issuer is not configured")
        with self._discovery_lock:
            if self._discovery and not force and (time.time() - self._discovery.fetched_at) < 3600:
                return self._discovery
            url = self.cfg.issuer.rstrip("/") + "/.well-known/openid-configuration"
            try:
                r = httpx.get(url, timeout=10.0, follow_redirects=True)
                r.raise_for_status()
                d = r.json()
            except Exception as e:
                raise OidcError(f"OIDC discovery failed for {url}: {e}") from e
            self._discovery = Discovery(
                authorization_endpoint=d.get("authorization_endpoint", ""),
                token_endpoint=d.get("token_endpoint", ""),
                userinfo_endpoint=d.get("userinfo_endpoint", ""),
                end_session_endpoint=d.get("end_session_endpoint", ""),
                jwks_uri=d.get("jwks_uri", ""),
                issuer=d.get("issuer", self.cfg.issuer),
                fetched_at=time.time(),
            )
            if not self._discovery.authorization_endpoint or not self._discovery.token_endpoint:
                raise OidcError("Discovery document missing authorization_endpoint/token_endpoint")
            return self._discovery

    # ---- auth request ----------------------------------------------
    def build_auth_url(self, state: str, code_verifier: Optional[str]) -> str:
        d = self.discovery()
        params: Dict[str, str] = {
            "response_type": "code",
            "client_id": self.cfg.client_id,
            "redirect_uri": self.cfg.redirect_url,  # verbatim from config
            "state": state,
            "scope": self.cfg.scope,
        }
        if code_verifier:
            params["code_challenge"] = code_challenge(code_verifier)
            params["code_challenge_method"] = "S256"
        return d.authorization_endpoint + "?" + urlencode(params, safe="")

    # ---- token exchange --------------------------------------------
    def exchange_code(self, code: str, code_verifier: Optional[str]) -> TokenSet:
        d = self.discovery()
        data: Dict[str, str] = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.cfg.redirect_url,  # verbatim
            "client_id": self.cfg.client_id,
        }
        if self.cfg.is_public:
            if not code_verifier:
                raise OidcError("public client requires PKCE code_verifier")
            data["code_verifier"] = code_verifier
        else:
            data["client_secret"] = self.cfg.client_secret

        try:
            r = httpx.post(d.token_endpoint, data=data, timeout=15.0, follow_redirects=True)
        except Exception as e:
            raise OidcError(f"token endpoint unreachable: {e}") from e
        if r.status_code >= 400:
            raise OidcError(f"token exchange failed: {r.status_code} {r.text}")
        tok = r.json()
        return TokenSet(
            access_token=tok.get("access_token", ""),
            id_token=tok.get("id_token", ""),
            refresh_token=tok.get("refresh_token", ""),
            token_type=tok.get("token_type", "Bearer"),
            expires_in=int(tok.get("expires_in", 0) or 0),
            obtained_at=time.time(),
            raw=tok,
        )

    # ---- refresh ----------------------------------------------------
    def refresh(self, refresh_token: str) -> TokenSet:
        d = self.discovery()
        data: Dict[str, str] = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.cfg.client_id,
        }
        if not self.cfg.is_public:
            data["client_secret"] = self.cfg.client_secret
        try:
            r = httpx.post(d.token_endpoint, data=data, timeout=15.0, follow_redirects=True)
        except Exception as e:
            raise OidcError(f"token endpoint unreachable: {e}") from e
        if r.status_code >= 400:
            raise OidcError(f"token refresh failed: {r.status_code}")
        tok = r.json()
        return TokenSet(
            access_token=tok.get("access_token", ""),
            id_token=tok.get("id_token", ""),
            refresh_token=tok.get("refresh_token", refresh_token),
            token_type=tok.get("token_type", "Bearer"),
            expires_in=int(tok.get("expires_in", 0) or 0),
            obtained_at=time.time(),
            raw=tok,
        )

    # ---- userinfo + id token claims --------------------------------
    def userinfo(self, access_token: str) -> Dict:
        d = self.discovery()
        if not d.userinfo_endpoint:
            return {}
        r = httpx.get(
            d.userinfo_endpoint,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10.0,
            follow_redirects=True,
        )
        if r.status_code >= 400:
            return {}
        return r.json()

    @staticmethod
    def decode_id_token(id_token: str) -> Dict:
        """Decode the ID token *without* signature verification.

        The token is received directly from the token endpoint over TLS
        (server-side), not from the browser, so signature verification is not
        required for correctness here. The claims are trusted as coming from
        the IdP. JWKS verification can be added later.
        """
        try:
            _, payload, _ = id_token.split(".")
            padding = "=" * (-len(payload) % 4)
            decoded = base64.urlsafe_b64decode(payload + padding)
            return json.loads(decoded)
        except Exception:
            return {}

    def extract_groups(self, tokens: TokenSet) -> list:
        claim = self.cfg.groups_claim or "groups"
        claims: Dict = {}
        if tokens.id_token:
            claims = self.decode_id_token(tokens.id_token) or {}
        if claim not in claims and tokens.access_token:
            ui = self.userinfo(tokens.access_token)
            if isinstance(ui, dict):
                claims.update(ui)
        val = claims.get(claim, [])
        if isinstance(val, str):
            return [val]
        if isinstance(val, list):
            return list(val)
        return []

    @staticmethod
    def _username_from_claims(claims: Dict) -> str:
        for k in ("preferred_username", "email", "name", "sub"):
            v = claims.get(k)
            if v:
                return str(v)
        return "user"

    # ---- logout -----------------------------------------------------
    def end_session_url(self, id_token_hint: str) -> str:
        """Build the RP-initiated logout URL.

        Uses the IdP end_session_endpoint from discovery; falls back to the
        explicit backend_logout_url from config if discovery exposed none.
        """
        d = self.discovery()
        endpoint = d.end_session_endpoint or self.cfg.backend_logout_url
        if not endpoint:
            return ""
        # post_logout_redirect_uri = origin of redirect_url + "/"
        origin = self._origin(self.cfg.redirect_url)
        params: Dict[str, str] = {}
        if id_token_hint:
            params["id_token_hint"] = id_token_hint
        if origin:
            params["post_logout_redirect_uri"] = origin
        sep = "&" if "?" in endpoint else "?"
        return endpoint + sep + urlencode(params, safe="")

    @staticmethod
    def _origin(url: str) -> str:
        try:
            u = urlparse(url)
            if not u.scheme or not u.netloc:
                return ""
            return f"{u.scheme}://{u.netloc}/"
        except Exception:
            return ""
