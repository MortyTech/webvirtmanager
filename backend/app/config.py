"""
Configuration loader.

All configuration — OIDC, VNC mode, and the list of hosts — lives in a single INI
file read on startup and reloadable via SIGHUP or POST /api/config/reload.

Hosts are defined as their own INI sections (one per host) for granular control
over the connection transport and credentials:

    [node03]
    connection_uri = qemu+ssh://192.168.1.110/system
    auth_type = ssh_key            # mandatory; one of ssh_key | sasl | none
    key_file = ~/.ssh/id_rsa       # ssh_key only; omit to use the default key

    [node02]
    connection_uri = qemu+tcp://192.168.1.111/system
    auth_type = sasl               # qemu+tcp SASL -> username + password required
    username = admin
    password = MySecretPassword123

    [node04]
    connection_uri = qemu+tcp://192.168.1.112/system
    auth_type = none               # qemu+tcp plain (no auth); username/password ignored

Rules:
  - auth_type is MANDATORY for every host.
  - ssh_key: key_file is optional (defaults to the mapped ~/.ssh key).
  - sasl: username AND password are required (else the app refuses to start).
  - none: username/password are ignored even if present.

Env overrides (take precedence over the file when set):
    CONFIG_PATH         path to the INI file            default: ./config.ini  (or /app/config.ini in container)
    OIDC_ENABLED        "false"/"0"/"no"/"off" disables OIDC entirely
    SESSION_SECRET      signing key for the session cookie (auto-generated if unset)
    STATIC_DIR          directory of compiled frontend assets  default: ./static
"""
from __future__ import annotations

import configparser
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List
from urllib.parse import urlparse

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


class ConfigError(RuntimeError):
    """Raised on startup/reload when one or more host blocks are misconfigured
    (the app refuses to start; the message names every offending block)."""


def _as_bool(v: str, default: bool) -> bool:
    if v is None:
        return default
    s = v.strip().lower()
    if s in _TRUE:
        return True
    if s in _FALSE:
        return False
    return default


@dataclass
class OidcConfig:
    enabled: bool = True
    issuer: str = ""
    client_id: str = ""
    client_secret: str = ""
    client_type: str = "confidential"  # "confidential" | "public"
    redirect_url: str = ""
    backend_logout_url: str = ""
    scope: str = "openid profile email"
    groups_claim: str = "groups"
    allowed_groups: list = field(default_factory=list)  # [] = allow all (backward compatible)

    @property
    def is_public(self) -> bool:
        return self.client_type.strip().lower() == "public"


@dataclass
class VncConfig:
    mode: str = "ssh"  # "ssh" (default) | "direct" — global override for ssh-transport hosts

    @property
    def is_direct(self) -> bool:
        return self.mode.strip().lower() == "direct"


@dataclass
class HostConfig:
    name: str
    connection_uri: str = ""
    auth_type: str = ""            # ssh_key | sasl | none  (mandatory)
    key_file: str = ""            # ssh_key only; "" = default mapped key
    username: str = ""            # sasl only
    password: str = ""            # sasl only

    @property
    def transport(self) -> str:
        """'ssh', 'tcp', or '' for the libvirt URI scheme (qemu+ssh/tcp)."""
        scheme = urlparse(self.connection_uri).scheme or ""
        if "+" in scheme:
            return scheme.split("+", 1)[1].lower()
        return scheme.lower()


@dataclass
class Config:
    oidc: OidcConfig = field(default_factory=OidcConfig)
    vnc: VncConfig = field(default_factory=VncConfig)
    hosts: Dict[str, HostConfig] = field(default_factory=dict)  # name -> HostConfig
    loaded_at: float = 0.0
    path: str = ""


class ConfigStore:
    """Thread-safe holder of the currently active config."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.RLock()
        self._cfg: Config = Config(path=path)
        self.reload()  # raises ConfigError on misconfig -> app refuses to start

    def reload(self) -> Config:
        cfg = _parse_ini(self._path)
        env_en = os.environ.get("OIDC_ENABLED")
        if env_en is not None and env_en.strip() != "":
            cfg.oidc.enabled = _as_bool(env_en, cfg.oidc.enabled)
        with self._lock:
            self._cfg = cfg
        return cfg

    def get(self) -> Config:
        with self._lock:
            return self._cfg


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


# Sections that are NOT hosts.
_NON_HOST_SECTIONS = {"oidc", "vnc", "hosts"}

_VALID_AUTH_TYPES = {"ssh_key", "sasl", "none"}


def _validate_hosts(hosts: Dict[str, HostConfig]) -> None:
    """Fail fast on misconfiguration, naming every offending block."""
    errors: List[str] = []
    for name, h in hosts.items():
        if not h.connection_uri:
            errors.append(f"[{name}]: missing 'connection_uri'")
        if not h.auth_type:
            errors.append(f"[{name}]: 'auth_type' is mandatory (one of: ssh_key, sasl, none)")
            continue  # no point checking further rules without an auth_type
        if h.auth_type not in _VALID_AUTH_TYPES:
            errors.append(
                f"[{name}]: invalid auth_type '{h.auth_type}' (must be ssh_key, sasl, or none)"
            )
            continue
        # transport <-> auth_type consistency
        t = h.transport
        if t == "ssh" and h.auth_type != "ssh_key":
            errors.append(f"[{name}]: qemu+ssh connection requires auth_type=ssh_key (got '{h.auth_type}')")
        elif t == "tcp" and h.auth_type not in ("sasl", "none"):
            errors.append(f"[{name}]: qemu+tcp connection requires auth_type=sasl or none (got '{h.auth_type}')")
        # per-auth_type credential rules
        if h.auth_type == "sasl":
            if not h.username:
                errors.append(f"[{name}]: auth_type=sasl requires 'username'")
            if not h.password:
                errors.append(f"[{name}]: auth_type=sasl requires 'password'")
        # ssh_key: key_file optional; none: username/password ignored
    if errors:
        raise ConfigError(
            "Host configuration error(s) — refusing to start:\n"
            + "\n".join("  - " + e for e in errors)
        )


def _parse_ini(path: str) -> Config:
    p = Path(path)
    cfg = Config(path=path, loaded_at=time.time())
    if not p.exists():
        # Missing file is allowed when OIDC is disabled (trusted-network mode).
        cfg.oidc = OidcConfig(enabled=False)
        return cfg

    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str  # preserve case for host keys / section names
    parser.read(path)

    oidc = OidcConfig()
    if parser.has_section("oidc"):
        oidc.enabled = _as_bool(parser.get("oidc", "enabled", fallback="true"), True)
        oidc.issuer = parser.get("oidc", "issuer", fallback="").strip()
        oidc.client_id = parser.get("oidc", "client_id", fallback="").strip()
        oidc.client_secret = _strip_quotes(parser.get("oidc", "client_secret", fallback=""))
        oidc.client_type = parser.get("oidc", "client_type", fallback="confidential").strip().lower()
        oidc.redirect_url = parser.get("oidc", "redirect_url", fallback="").strip()
        oidc.backend_logout_url = parser.get("oidc", "backend_logout_url", fallback="").strip()
        oidc.scope = _strip_quotes(parser.get("oidc", "scope", fallback="openid profile email"))
        oidc.groups_claim = parser.get("oidc", "oidc_groups_claim", fallback="groups").strip()
        _ag = parser.get("oidc", "allowed_groups", fallback="")
        oidc.allowed_groups = [g.strip() for g in _ag.split(",") if g.strip()]
        if oidc.is_public:
            oidc.client_secret = ""
    cfg.oidc = oidc

    vnc = VncConfig()
    if parser.has_section("vnc"):
        vnc.mode = parser.get("vnc", "mode", fallback="ssh").strip().lower()
        if vnc.mode not in ("ssh", "direct"):
            vnc.mode = "ssh"
    cfg.vnc = vnc

    hosts: Dict[str, HostConfig] = {}

    # Legacy [hosts] section: name = uri  (treated as auth_type=ssh_key, default key)
    if parser.has_section("hosts"):
        for name, val in parser.items("hosts"):
            name = name.strip()
            val = val.strip()
            if name and val:
                hosts[name] = HostConfig(name=name, connection_uri=val, auth_type="ssh_key")

    # Per-host sections (new, granular format). A section wins over a legacy
    # [hosts] entry of the same name.
    for sec in parser.sections():
        if sec in _NON_HOST_SECTIONS:
            continue
        name = sec.strip()
        if not name:
            continue
        hosts[name] = HostConfig(
            name=name,
            connection_uri=parser.get(sec, "connection_uri", fallback="").strip(),
            auth_type=parser.get(sec, "auth_type", fallback="").strip().lower(),
            key_file=parser.get(sec, "key_file", fallback="").strip(),
            username=parser.get(sec, "username", fallback="").strip(),
            password=_strip_quotes(parser.get(sec, "password", fallback="")),
        )

    cfg.hosts = hosts
    _validate_hosts(hosts)
    return cfg


_DEFAULT_PATH = os.environ.get(
    "CONFIG_PATH",
    "/app/config.ini" if Path("/app/config.ini").exists() else str(Path(__file__).resolve().parent.parent / "config.ini"),
)

store = ConfigStore(_DEFAULT_PATH)


def get_config() -> Config:
    return store.get()


def reload_config() -> Config:
    return store.reload()
