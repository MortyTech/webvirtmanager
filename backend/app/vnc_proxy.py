"""
WebSocket-to-VNC proxy (websockify-equivalent).

Flow:
  1. POST /api/hosts/{host}/vms/{vm}/vnc  (authed)
       - libvirt gives the VM's VNC port + listen addr
       - we open an `ssh -N -L localport:<listen>:<vncport> user@host` tunnel
       - register a token -> {local_port, ssh_proc} and return it
  2. WS /vnc/ws/{token}  (noVNC client connects here, same origin)
       - verify the session cookie (must be authed)
       - accept the WebSocket, open a TCP socket to the local tunnel port
       - pump bytes both ways until either side closes

Everything runs over the single public port (no separate websockify process).
"""
from __future__ import annotations

import asyncio
import os
import secrets
import socket
import subprocess
import threading
import time
from typing import Dict, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .auth import COOKIE_NAME, _verify
from .libvirt_api import vm_vnc_info, HostUnreachable, VmNotFound

router = APIRouter()

VNC_SESSION_TTL = 600  # seconds an idle tunnel stays alive

_lock = threading.Lock()
_sessions: Dict[str, dict] = {}  # token -> {host, vm, local_port, ssh_proc, created_at, last_seen, owner_sid}


def _alloc_local_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _ssh_target(uri: str) -> str:
    """user@host from a qemu+ssh://user@host/system URI."""
    p = urlparse(uri)
    user = p.username or "root"
    host = p.hostname or "localhost"
    return f"{user}@{host}"


def _spawn_tunnel(ssh_target: str, vnc_port: int, listen: str) -> tuple[Optional[subprocess.Popen], int]:
    local_port = _alloc_local_port()
    target_host = listen if listen and listen not in ("0.0.0.0", "::", "*") else "127.0.0.1"
    args = [
        "ssh", "-N",
        "-L", f"127.0.0.1:{local_port}:{target_host}:{vnc_port}",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        ssh_target,
    ]
    print(
        f"[vnc] spawning ssh tunnel: {ssh_target}  127.0.0.1:{local_port} -> {target_host}:{vnc_port}",
        flush=True,
    )
    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except FileNotFoundError as e:
        raise RuntimeError("openssh client (ssh) not found in PATH") from e

    # Wait until the local forward actually accepts a TCP connection (or ssh exits).
    deadline = time.time() + 8.0
    last_err = ""
    while time.time() < deadline:
        rc = proc.poll()
        if rc is not None:
            err = b""
            try:
                err = proc.stderr.read() or b""
            except Exception:
                pass
            raise RuntimeError(
                f"ssh tunnel exited (rc={rc}): {err.decode(errors='replace').strip()}"
            )
        try:
            s = socket.create_connection(("127.0.0.1", local_port), timeout=1)
            s.close()
            return proc, local_port
        except Exception as e:
            last_err = str(e)
            time.sleep(0.15)
    raise RuntimeError(
        f"ssh tunnel did not become ready on 127.0.0.1:{local_port} within 8s: {last_err}"
    )


def _probe_vnc(local_port: int, timeout: float = 5.0) -> None:
    """Verify the tunneled port actually speaks RFB (a real VNC server is there).

    Uses a throwaway connection — VNC servers accept multiple concurrent
    clients, so the noVNC session later opens its own fresh connection and the
    server sends the RFB greeting again."""
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            s = socket.create_connection(("127.0.0.1", local_port), timeout=2)
            try:
                s.settimeout(2)
                greeting = s.recv(13)
            finally:
                s.close()
            if greeting.startswith(b"RFB "):
                print(f"[vnc] probe ok on local port {local_port}: {greeting!r}", flush=True)
                return
            last = f"unexpected greeting {greeting!r}"
        except Exception as e:
            last = str(e)
            time.sleep(0.2)
    raise RuntimeError(
        f"VNC server did not answer RFB handshake on local tunnel port {local_port}: {last}"
    )


def create_vnc_session(host: str, vm: str, owner_sid: str, uri: str) -> dict:
    info = vm_vnc_info(host, vm)
    if not info.get("port"):
        raise RuntimeError(
            "VM has no VNC graphics device configured, or it is not running yet "
            "(autoport port is unassigned until the domain is running)."
        )
    if info.get("state") not in ("running",):
        raise RuntimeError(f"VM is {info.get('state')}, cannot open VNC")
    ssh_target = _ssh_target(uri)
    proc, local_port = _spawn_tunnel(
        ssh_target, int(info["port"]), info.get("listen", "127.0.0.1")
    )
    # Verify end-to-end that the tunnel reaches a real VNC server BEFORE handing
    # out a token. If this fails, the POST returns a clear reason instead of the
    # frontend showing a generic "VNC session disconnected".
    try:
        _probe_vnc(local_port)
    except Exception as e:
        try:
            proc.terminate()
        except Exception:
            pass
        raise RuntimeError(
            f"VNC unreachable on {host} (vnc_port={info['port']}, "
            f"listen={info.get('listen')}): {e}"
        )
    token = secrets.token_urlsafe(32)
    with _lock:
        _sessions[token] = {
            "host": host,
            "vm": vm,
            "local_port": local_port,
            "ssh_proc": proc,
            "created_at": time.time(),
            "last_seen": time.time(),
            "owner_sid": owner_sid,
        }
    print(
        f"[vnc] session created: host={host} vm={vm} vnc_port={info['port']} "
        f"listen={info.get('listen')} local_port={local_port}",
        flush=True,
    )
    return {"token": token, "path": f"/vnc/ws/{token}", "vnc_port": info["port"]}


def _destroy_session(token: str) -> None:
    with _lock:
        entry = _sessions.pop(token, None)
    if not entry:
        return
    proc = entry.get("ssh_proc")
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
        except Exception:
            pass


def _gc_sessions() -> None:
    now = time.time()
    stale = []
    with _lock:
        for token, entry in list(_sessions.items()):
            if now - entry["last_seen"] > VNC_SESSION_TTL:
                stale.append(token)
    for t in stale:
        _destroy_session(t)


def start_reaper() -> None:
    async def _loop():
        while True:
            await asyncio.sleep(30)
            _gc_sessions()

    try:
        asyncio.get_running_loop().create_task(_loop())
    except RuntimeError:
        # No running loop yet (startup not finished) — caller will start it.
        pass


def _ws_session(websocket: WebSocket):
    """Resolve the session from the WS handshake cookie; returns Session or None."""
    cookie = websocket.headers.get("cookie", "")
    val = None
    for part in cookie.split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE_NAME and v:
            val = v
            break
    sid = _verify(val) if val else None
    if not sid:
        return None
    from . import auth as _auth
    return _auth.store.get(sid)


# ---- routes ---------------------------------------------------------------

async def _pump(ws: WebSocket, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    async def tcp_to_ws():
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                await ws.send_bytes(data)
        except Exception:
            pass
        finally:
            try:
                await ws.close(code=1000)
            except Exception:
                pass

    async def ws_to_tcp():
        try:
            while True:
                data = await ws.receive_bytes()
                writer.write(data)
                await writer.drain()
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    await asyncio.gather(tcp_to_ws(), ws_to_tcp(), return_exceptions=True)
    try:
        await writer.wait_closed()
    except Exception:
        pass


@router.websocket("/vnc/ws/{token}")
async def vnc_ws(websocket: WebSocket, token: str):
    # 1. session cookie must be present (authed user)
    session = _ws_session(websocket)
    from .config import get_config
    if get_config().oidc.enabled and session is None:
        await websocket.close(code=4401)  # custom: unauthenticated
        return
    # 2. token must map to a live VNC session
    with _lock:
        entry = _sessions.get(token)
        if entry:
            if session is not None and entry["owner_sid"] != session.sid and get_config().oidc.enabled:
                # token bound to another user
                entry = None
        if not entry or entry["ssh_proc"].poll() is not None:
            await websocket.accept()
            await websocket.close(code=4404)
            return
        entry["last_seen"] = time.time()
        local_port = entry["local_port"]

    # 3. accept WS and open TCP to the local SSH tunnel
    print(f"[vnc] ws connect -> 127.0.0.1:{local_port}", flush=True)
    await websocket.accept()
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", local_port)
    except Exception as e:
        print(f"[vnc] tcp connect to 127.0.0.1:{local_port} failed: {e}", flush=True)
        await websocket.close(code=1011)
        return

    try:
        await _pump(websocket, reader, writer)
    finally:
        print(f"[vnc] ws session ended (local_port={local_port})", flush=True)
        # keep the session alive for quick reconnects; reaper will clean up.
        pass
