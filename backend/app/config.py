"""
Configuration loader.

All configuration — OIDC settings and the list of hosts — lives in a single INI
file read on startup and reloadable via SIGHUP or POST /api/config/reload.

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
from typing import Dict

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


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

    @property
    def is_public(self) -> bool:
        return self.client_type.strip().lower() == "public"


@dataclass
class VncConfig:
    mode: str = "ssh"  # "ssh" (default) | "direct"

    @property
    def is_direct(self) -> bool:
        return self.mode.strip().lower() == "direct"


@dataclass
class Config:
    oidc: OidcConfig = field(default_factory=OidcConfig)
    vnc: VncConfig = field(default_factory=VncConfig)
    hosts: Dict[str, str] = field(default_factory=dict)  # name -> qemu+ssh:// uri
    loaded_at: float = 0.0
    path: str = ""


class ConfigStore:
    """Thread-safe holder of the currently active config."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.RLock()
        self._cfg: Config = Config(path=path)
        self.reload()

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


def _parse_ini(path: str) -> Config:
    p = Path(path)
    cfg = Config(path=path, loaded_at=time.time())
    if not p.exists():
        # Missing file is allowed when OIDC is disabled (trusted-network mode).
        cfg.oidc = OidcConfig(enabled=False)
        return cfg

    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str  # preserve case for host keys like node01
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

        if oidc.is_public:
            oidc.client_secret = ""

    cfg.oidc = oidc

    # [vnc] — how the WebSocket-to-VNC proxy reaches the VM's VNC port.
    #   ssh     (default): per-session `ssh -N -L` tunnel to the host (NAT/firewall)
    #   direct:           connect straight to <vnc host>:<port> (same-LAN deployments)
    vnc = VncConfig()
    if parser.has_section("vnc"):
        vnc.mode = parser.get("vnc", "mode", fallback="ssh").strip().lower()
        if vnc.mode not in ("ssh", "direct"):
            vnc.mode = "ssh"
    cfg.vnc = vnc

    if parser.has_section("hosts"):
        for name, val in parser.items("hosts"):
            name = name.strip()
            val = val.strip()
            if name and val:
                cfg.hosts[name] = val

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
