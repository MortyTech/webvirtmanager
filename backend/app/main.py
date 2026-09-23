"""
FastAPI application entrypoint.

Wires together:
  - conditional OIDC auth middleware + routes (only when oidc.enabled = true)
  - the /api/* REST routes
  - the /vnc/ws/{token} WebSocket-to-VNC proxy
  - static SPA serving (compiled React frontend)
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import AuthMiddleware, mount_auth_routes, mount_me_route, reset_client
from .config import get_config, reload_config
from .routes import router as api_router
from .vnc_proxy import router as vnc_router, start_reaper, _gc_sessions

STATIC_DIR = os.environ.get("STATIC_DIR", str(Path(__file__).resolve().parent.parent / "static"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_config()
    print(
        f"[webvirt] config loaded from {cfg.path} | "
        f"oidc.enabled={cfg.oidc.enabled} | hosts={list(cfg.hosts.keys())}",
        flush=True,
    )
    start_reaper()
    # Optional SIGHUP reload (best-effort; uvicorn may own signals in some setups)
    try:
        import signal

        def _hup(*_):
            print("[webvirt] SIGHUP received, reloading config", flush=True)
            reload_config()
            reset_client()

        signal.signal(signal.SIGHUP, _hup)
    except Exception:
        pass
    yield
    # shutdown
    from . import libvirt_api as lv
    lv.close_pool()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Webvirt",
        description="web virt-manager — libvirt over qemu+ssh, noVNC console, OIDC auth",
        version="1.0.0",
        lifespan=lifespan,
    )

    cfg = get_config()

    # /api/me is always available so the frontend can detect auth mode.
    mount_me_route(app)

    # Conditional auth: middleware + OIDC routes only when OIDC is enabled.
    if cfg.oidc.enabled:
        app.add_middleware(AuthMiddleware)
        mount_auth_routes(app)

    app.include_router(api_router)
    app.include_router(vnc_router)

    # Static SPA assets (Vite build output → dist/assets, copied into STATIC_DIR)
    assets_dir = Path(STATIC_DIR) / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    index_html = Path(STATIC_DIR) / "index.html"

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        c = get_config()
        return {"status": "ok", "oidc_enabled": c.oidc.enabled, "hosts": list(c.hosts.keys())}

    # SPA fallback: serve index.html for any non-API browser route.
    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str, request: Request):
        if full_path.startswith("api/") or full_path.startswith("vnc/"):
            return JSONResponse({"detail": "not found"}, status_code=404)
        if index_html.exists():
            return FileResponse(str(index_html), media_type="text/html")
        # Dev fallback when no frontend build is present.
        return JSONResponse(
            {
                "detail": "frontend build not found. Build the React app (frontend/) and "
                "copy its dist/ into STATIC_DIR (default ./static).",
                "static_dir": STATIC_DIR,
                "oidc_enabled": get_config().oidc.enabled,
                "hosts": list(get_config().hosts.keys()),
            },
            status_code=200,
        )

    return app


app = create_app()
