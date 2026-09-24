"""
Per-host SSH key loading via an in-process ssh-agent.

libvirt's qemu+ssh transport spawns `ssh`, which discovers keys from the
ssh-agent (SSH_AUTH_SOCK) and the default files in ~/.ssh. To honor a per-host
`key_file` (see the [host] sections in config.ini) for the libvirt connection
*and* the VNC ssh tunnel, we load each unique key_file into an ssh-agent at
startup and export SSH_AUTH_SOCK into the process environment so libvirt's ssh
subprocess inherits it.

If no host specifies a key_file, nothing happens (libvirt's ssh uses the default
mapped ~/.ssh key, as before). Failures are logged and non-fatal — a host whose
key couldn't be loaded will simply fail to connect with a clear libvirt error.
"""
from __future__ import annotations

import atexit
import os
import subprocess
from typing import Dict

_started = False


def _parse_agent_output(out: str):
    sock = pid = None
    for tok in out.replace("\n", "").split(";"):
        t = tok.strip()
        if t.startswith("SSH_AUTH_SOCK="):
            sock = t.split("=", 1)[1].strip().strip('"')
        elif t.startswith("SSH_AGENT_PID="):
            pid = t.split("=", 1)[1].strip().strip('"')
    return sock, pid


def _add_key(path: str) -> None:
    env = os.environ.copy()
    try:
        r = subprocess.run(["ssh-add", path], capture_output=True, text=True, env=env, timeout=10)
    except Exception as e:
        print(f"[ssh-agent] ssh-add {path} failed: {e}", flush=True)
        return
    if r.returncode == 0:
        print(f"[ssh-agent] loaded key {path}", flush=True)
    else:
        print(
            f"[ssh-agent] ssh-add {path} failed (rc={r.returncode}): "
            f"{(r.stderr or r.stdout).strip()}",
            flush=True,
        )


def maybe_start_agent(hosts: Dict[str, object]) -> None:
    """Start an ssh-agent and load any per-host key_files. No-op if none set."""
    global _started
    if _started:
        return
    keys = []
    seen = set()
    for h in hosts.values():
        auth = getattr(h, "auth_type", "")
        kf = getattr(h, "key_file", "")
        if auth == "ssh_key" and kf:
            p = os.path.expanduser(kf)
            if p not in seen:
                seen.add(p)
                keys.append(p)
    if not keys:
        return

    # If an agent is already available in the environment (e.g. forwarded into
    # the container), just load the keys into it.
    if os.environ.get("SSH_AUTH_SOCK"):
        _started = True
        print(f"[ssh-agent] using existing SSH_AUTH_SOCK; loading {len(keys)} key(s)", flush=True)
        for k in keys:
            _add_key(k)
        return

    try:
        r = subprocess.run(
            ["ssh-agent", "-s"], capture_output=True, text=True, timeout=5, check=True
        )
    except Exception as e:
        print(
            f"[ssh-agent] could not start ssh-agent (per-host key_file won't be "
            f"used; hosts will fall back to the default key): {e}",
            flush=True,
        )
        return
    sock, pid = _parse_agent_output(r.stdout)
    if not sock:
        print("[ssh-agent] could not parse ssh-agent output; skipping", flush=True)
        return
    os.environ["SSH_AUTH_SOCK"] = sock
    if pid:
        os.environ["SSH_AGENT_PID"] = pid
        _pid = pid
        atexit.register(
            lambda: subprocess.run(
                ["ssh-agent", "-k"], env=os.environ, capture_output=True
            )
        )
    _started = True
    print(
        f"[ssh-agent] started (sock={sock}); loading {len(keys)} key(s) for qemu+ssh hosts",
        flush=True,
    )
    for k in keys:
        _add_key(k)
