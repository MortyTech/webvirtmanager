"""
Authentication: session store, signed cookie, conditional auth middleware,
and the OIDC routes (/login, /oauth2/callback, /logout, /api/me).

When OIDC is disabled (enabled = false) the middleware is not registered at all,
no OIDC routes are mounted, and the app serves everything unauthenticated.
"""
from __future__ import annotations

import hmac
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

from .config import get_config
from .oidc import OidcClient, TokenSet, gen_code_verifier, gen_state

COOKIE_NAME = "webvirt_sid"
PENDING_TTL = 600  # seconds
SESSION_TTL = 8 * 3600  # idle timeout


@dataclass
class Session:
    sid: str
    username: str
    groups: list = field(default_factory=list)
    tokens: Optional[TokenSet] = None
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)


class SessionStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: Dict[str, Session] = {}
        self._pending: Dict[str, dict] = {}  # state -> {verifier, ts}

    # ---- pending auth (state + PKCE verifier) ---------------------
    def add_pending(self, state: str, verifier: Optional[str]) -> None:
        self._gc_pending()
        with self._lock:
            self._pending[state] = {"verifier": verifier, "ts": time.time()}

    def take_pending(self, state: str) -> Optional[str]:
        with self._lock:
            entry = self._pending.pop(state, None)
        if not entry:
            return None
        if time.time() - entry["ts"] > PENDING_TTL:
            return None
        return entry["verifier"]

    def _gc_pending(self) -> None:
        now = time.time()
        with self._lock:
            for k in [k for k, v in self._pending.items() if now - v["ts"] > PENDING_TTL]:
                self._pending.pop(k, None)

    # ---- sessions --------------------------------------------------
    def create(self, username: str, groups: list, tokens: TokenSet) -> Session:
        sid = secrets.token_urlsafe(32)
        s = Session(sid=sid, username=username, groups=groups, tokens=tokens)
        with self._lock:
            self._sessions[sid] = s
        return s

    def get(self, sid: str) -> Optional[Session]:
        with self._lock:
            s = self._sessions.get(sid)
            if not s:
                return None
            if time.time() - s.last_seen > SESSION_TTL:
                self._sessions.pop(sid, None)
                return None
            s.last_seen = time.time()
            return s

    def update(self, sid: str, tokens: TokenSet) -> None:
        with self._lock:
            s = self._sessions.get(sid)
            if s:
                s.tokens = tokens

    def destroy(self, sid: str) -> None:
        with self._lock:
            self._sessions.pop(sid, None)


store = SessionStore()


# ---- signed cookie ----------------------------------------------------------

def _secret() -> bytes:
    import os
    s = os.environ.get("SESSION_SECRET")
    if s:
        return s.encode("utf-8")
    return _FALLBACK_SECRET


import os as _os  # noqa

_FallbackGen = secrets.SystemRandom()
_FALLBACK_SECRET = secrets.token_urlsafe(48).encode("utf-8")  # regenerated each process start


def _sign(sid: str) -> str:
    sig = hmac.new(_secret(), sid.encode("utf-8"), "sha256").hexdigest()
    return f"{sid}.{sig}"


def _verify(value: str) -> Optional[str]:
    if not value or "." not in value:
        return None
    sid, _, sig = value.rpartition(".")
    if not sid or not sig:
        return None
    expected = hmac.new(_secret(), sid.encode("utf-8"), "sha256").hexdigest()
    if hmac.compare_digest(sig, expected):
        return sid
    return None


def set_session_cookie(resp: Response, sid: str) -> None:
    cfg = get_config()
    secure = cfg.oidc.redirect_url.lower().startswith("https://") if cfg.oidc.enabled else False
    resp.set_cookie(
        COOKIE_NAME,
        _sign(sid),
        max_age=SESSION_TTL,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(resp: Response) -> None:
    resp.delete_cookie(COOKIE_NAME, path="/")


def current_session(request: Request) -> Optional[Session]:
    val = request.cookies.get(COOKIE_NAME)
    sid = _verify(val) if val else None
    if not sid:
        return None
    return store.get(sid)


# ---- middleware -------------------------------------------------------------

# Paths that never require a session (when OIDC is enabled).
PUBLIC_PREFIXES = ("/assets/", "/static/", "/api/healthz", "/favicon.ico", "/robots.txt")
PUBLIC_EXACT = {"/login", "/oauth2/callback", "/logout", "/healthz", "/api/healthz"}


def _is_public(path: str) -> bool:
    if path in PUBLIC_EXACT:
        return True
    return path.startswith(PUBLIC_PREFIXES)


def ensure_fresh(session: Session, client: OidcClient) -> bool:
    """Refresh the access token if it's expired. Returns False if refresh failed."""
    if not session.tokens:
        return False
    if not session.tokens.access_token_expired():
        return True
    if not session.tokens.refresh_token:
        return False
    try:
        new = client.refresh(session.tokens.refresh_token)
    except Exception:
        return False
    # IdP may not return a new id_token; keep the old one if absent.
    if not new.id_token and session.tokens.id_token:
        new.id_token = session.tokens.id_token
    if not new.refresh_token and session.tokens.refresh_token:
        new.refresh_token = session.tokens.refresh_token
    store.update(session.sid, new)
    session.tokens = new
    return True


class AuthMiddleware(BaseHTTPMiddleware):
    """Protects every non-public route when OIDC is enabled.

    - API paths (/api/...) → 401 JSON if unauthenticated.
    - Browser paths → 302 redirect to /login (which 302s to the IdP).
    - Expired access tokens are refreshed transparently.
    """

    async def dispatch(self, request: StarletteRequest, call_next):
        cfg = get_config()
        if not cfg.oidc.enabled:
            return await call_next(request)

        path = request.url.path
        # WebSocket paths are handled inside the WS endpoint.
        if path.startswith("/vnc/"):
            return await call_next(request)
        if _is_public(path):
            return await call_next(request)

        session = current_session(request)
        if session is not None:
            client = _get_client()
            if not ensure_fresh(session, client):
                store.destroy(session.sid)
                session = None
        if session is None:
            if path.startswith("/api/"):
                return JSONResponse(
                    {"detail": "unauthenticated"}, status_code=401,
                    headers={"X-Auth-Required": "1"},
                )
            return RedirectResponse("/login", status_code=302)

        request.state.session = session
        return await call_next(request)


# ---- OIDC client (built from current config, rebuilt on reload) -------------

_client: Optional[OidcClient] = None
_client_lock = threading.Lock()


def _get_client() -> OidcClient:
    global _client
    cfg = get_config()
    with _client_lock:
        if _client is None or _client.cfg is not cfg.oidc:
            _client = OidcClient(cfg.oidc)
        return _client


def reset_client() -> None:
    global _client
    with _client_lock:
        _client = None


# ---- routes ----------------------------------------------------------------

def mount_me_route(app: FastAPI) -> None:
    """Always register /api/me — even when OIDC is disabled, so the frontend
    can detect auth mode and hide the logout button accordingly."""

    @app.get("/api/me")
    async def me(request: Request):
        cfg = get_config()
        if not cfg.oidc.enabled:
            return {"auth_enabled": False, "username": "anonymous", "groups": []}
        session = current_session(request)
        if not session:
            return JSONResponse(
                {"auth_enabled": True, "detail": "unauthenticated"},
                status_code=401,
            )
        return {
            "auth_enabled": True,
            "username": session.username,
            "groups": session.groups,
            "token_expires_at": session.tokens.expires_at if session.tokens else None,
        }


def mount_auth_routes(app: FastAPI) -> None:
    """Register /login, /oauth2/callback, /logout.

    Only called when OIDC is enabled.
    """

    @app.get("/login")
    async def login(request: Request):
        cfg = get_config()
        if not cfg.oidc.enabled:
            return RedirectResponse("/", status_code=302)
        client = _get_client()
        state = gen_state()
        verifier = gen_code_verifier() if cfg.oidc.is_public else None
        store.add_pending(state, verifier)
        url = client.build_auth_url(state, verifier)
        return RedirectResponse(url, status_code=302)

    @app.get("/oauth2/callback")
    async def callback(request: Request, code: str = "", state: str = "", error: str = "", error_description: str = ""):
        cfg = get_config()
        if error:
            return JSONResponse(
                {"detail": f"OIDC error: {error} - {error_description}"},
                status_code=400,
            )
        if not code or not state:
            return JSONResponse({"detail": "missing code/state"}, status_code=400)
        verifier = store.take_pending(state)
        if verifier is None and cfg.oidc.is_public:
            return JSONResponse({"detail": "invalid or expired state (PKCE verifier missing)"}, status_code=400)
        if verifier is None:
            # confidential flow: state must still be recognised
            return JSONResponse({"detail": "invalid or expired state"}, status_code=400)
        client = _get_client()
        try:
            tokens = client.exchange_code(code, verifier)
        except Exception as e:
            return JSONResponse({"detail": f"token exchange failed: {e}"}, status_code=400)
        groups = client.extract_groups(tokens)
        claims = client.decode_id_token(tokens.id_token) if tokens.id_token else {}
        username = client._username_from_claims(claims)
        session = store.create(username, groups, tokens)
        resp = RedirectResponse("/", status_code=302)
        set_session_cookie(resp, session.sid)
        return resp

    @app.get("/logout")
    async def logout(request: Request):
        cfg = get_config()
        session = current_session(request)
        id_token_hint = ""
        if session and session.tokens:
            id_token_hint = session.tokens.id_token or ""
            store.destroy(session.sid)
        client = _get_client()
        try:
            url = client.end_session_url(id_token_hint)
        except Exception:
            url = ""
        resp = RedirectResponse(url or "/", status_code=302)
        clear_session_cookie(resp)
        return resp
