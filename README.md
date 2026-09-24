# Webvirt — a web-based virt-manager

A containerized web app that does what `virt-manager` does, but in the browser:

- **Backend**: Python + FastAPI, talks to libvirt over `qemu+ssh` only.
- **Frontend**: React + TypeScript (Vite), with **noVNC** for VM consoles.
- **VNC**: a WebSocket-to-VNC proxy (websockify-equivalent) inside the backend
  opens an SSH tunnel to each VM's VNC port and bridges it to a WebSocket on the
  same origin — no second port, no separate process.
- **Auth**: OIDC only — there is **no login page**. Hitting the app immediately
  redirects to the configured IdP (Authorization Code flow, with PKCE for public
  clients). Supports **`enabled = false`** to disable auth on trusted internal
  networks.
- **Config**: a **single INI file** (OIDC + hosts). No database. Reloadable via
  `SIGHUP` or `POST /api/config/reload`.
- **One dashboard.** No admin panel, no snapshots/migration/storage/network.

---

## Features (exactly what's implemented)

- Host list with reachability status (probed via libvirt `openReadOnly`).
- Per-host VM (domain) list with live power state.
- Per-VM actions: **power on**, **power off** (hard), **soft shutdown** (ACPI),
  **hard reset** (force reboot), **soft reboot** (ACPI), and **open VNC console**.
- Live VM statistics — **CPU, RAM, Disk, Network** — via libvirt
  (`dom.info`, `dom.memoryStats`, `dom.blockStats`, `dom.interfaceStats`).
  Cumulative counters are returned by the server; **rates are computed
  client-side**, and **the frontend alone controls the polling cadence**
  (minimum 10 s, default 30 s, no server-side scheduler).

---

## Architecture

```
Browser ──HTTPS/WSS──▶ FastAPI (:8000) ──OIDC-gated──▶ libvirt (qemu+ssh) ──▶ QEMU/KVM + VNC
   │                         │  REST API                        │
   │                         │  /vnc/ws/{token} (WS↔TCP pump)   │
   │                         │  static React SPA                │
   ▼                         ▼                                   ▼
React + TS (Vite)      ssh -N -L 127.0.0.1:port:<vncport>   127.0.0.1:5900+N
noVNC client           (per-session SSH tunnel)            (VNC listener on the host)
```

Everything runs on **one port (8000)** in the container.

---

## Configuration — single INI file

See [`backend/config.ini.example`](backend/config.ini.example). Key points:

```ini
[oidc]
enabled = true                                   ; secure-by-default; false = no auth (trusted nets only)
issuer = https://keycloak.example.com/realms/example
client_id = my-client-id
client_secret = my-client-secret                 ; OMIT entirely for public (PKCE) clients
client_type = confidential                         ; or "public"
redirect_url = https://webvirt.example.com/oauth2/callback ; used verbatim — never derived from the Host header
backend_logout_url = https://keycloak.example.com/realms/example/protocol/openid-connect/logout
scope = "openid profile email"                    ; read from config, never hardcoded
oidc_groups_claim = groups                        ; parsed from the ID token / userinfo

# Group-based access control (optional). Comma-separated group names.
#   empty/missing = allow all authenticated users (default, backward compatible)
#   non-empty     = user must be in at least one listed group; if the IdP
#                   returns NO groups claim at all, login is DENIED (fail closed)
# Denied attempts are logged: [auth] DENY user=... groups=... allowed_groups=...
allowed_groups = Admins, DevOps, Infrastructure

[hosts]
node01 = qemu+ssh://root@node01/system
node02 = qemu+ssh://root@node02/system

# VNC console connection mode:
#   ssh (default) — per-session SSH tunnel to the host (NAT/firewall between
#                   Webvirt and the KVM hosts).
#   direct        — connect straight to <host>:<vnc port>, no SSH tunnel. Use
#                   when Webvirt is on the same LAN as the KVM hosts. REQUIRES
#                   the VM's VNC to listen on a reachable address
#                   (0.0.0.0 or a host LAN IP), not 127.0.0.1.
[vnc]
mode = ssh
```

### OIDC behaviour

- **Discovery-driven**: `{issuer}/.well-known/openid-configuration` resolves the
  authorization, token, userinfo, and end-session endpoints — nothing Keycloak-specific.
- **`redirect_url` is verbatim** — never constructed from the request Host header;
  must match the IdP-registered URI byte-for-byte. The backend callback route is
  the path of `redirect_url` (e.g. `/oauth2/callback`).
- **Confidential client**: standard Authorization Code + `client_secret` in the
  token exchange (server-side only).
- **Public client**: Authorization Code + **PKCE (S256)**; no secret anywhere.
- **State** is validated (CSRF); for public clients the **PKCE `code_verifier`**
  is stored server-side (keyed by `state`) and sent in the token exchange.

#### What `redirect_url` and `backend_logout_url` are, and what to put in them

`redirect_url` and `backend_logout_url` are **just example hostnames** in this file
(`webvirt.example.com`, `keycloak.example.com`) — replace them with the real
addresses of **your** Webvirt instance and **your** IdP.

- **`redirect_url`** — the exact URL the IdP redirects the browser back to after
  login. It is the public address users hit Webvirt at, with the fixed
  `/oauth2/callback` path, and it **must match byte-for-byte** the redirect URI
  registered on the IdP client. Use whatever scheme/host/port your deployment
  actually exposes:

  - Webvirt running directly (no reverse proxy), reached by IP+port:
    ```
    redirect_url = http://172.16.21.11:8000/oauth2/callback
    ```
  - Webvirt behind a reverse proxy / FQDN with TLS:
    ```
    redirect_url = https://webvirt.example.com/oauth2/callback
    ```

  Notes:
  - `http://` vs `https://` matters — it must match how the IdP will call you
    back (use `https://` when behind a TLS-terminating reverse proxy; `http://`
    for a direct, no-TLS deployment like the IP example above).
  - The host:port is your **public** address, not the container's internal one.
    E.g. `docker run -p 8000:8000` reached on the host IP `172.16.21.11` →
    `http://172.16.21.11:8000/oauth2/callback`.
  - The path is always `/oauth2/callback` (the backend callback route).

- **`backend_logout_url`** — the IdP's RP-initiated-logout endpoint. It's a
  **fallback** used only if the OIDC discovery document does not expose an
  `end_session_endpoint` (most do, including Keycloak). For Keycloak it's:
  ```
  backend_logout_url = https://keycloak.example.com/realms/example/protocol/openid-connect/logout
  ```
  On logout the app sends `id_token_hint` + `post_logout_redirect_uri` (derived
  from the **origin** of `redirect_url`), so after the IdP logs the user out it
  sends them back to Webvirt — which immediately re-triggers the login redirect.

- **Groups claim** named by `oidc_groups_claim` is decoded from the ID token
  (falling back to userinfo) and stored in the session; exposed at `GET /api/me`.
- **Token refresh**: expired access tokens are refreshed via the refresh token
  before hitting libvirt endpoints; refresh failure → redirect to re-authenticate.
- **Logout is a real logout**: destroys the local session **and** redirects to the
  IdP `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri`.
  Falls back to the explicit `backend_logout_url` if discovery has no end-session
  endpoint. After IdP logout the user lands back on the app, which re-triggers the
  login redirect (no login page).

### Disabling authentication (`enabled = false`)

> ⚠️ **Only use on trusted internal networks — this disables ALL access control.**

When `enabled = false` (or `OIDC_ENABLED=false`), the app:

- Skips the entire OIDC flow — no IdP redirect, no callback route, no session/token logic.
- Serves the dashboard **unauthenticated** at `/`.
- Hides the logout button in the UI (there is no session to destroy).
- Does **not** fail to start if OIDC keys (`issuer`, `client_id`, `redirect_url`, …) are missing.

`enabled` defaults to **true** (secure-by-default) if the key is absent.

---

## Run it

### With `docker compose`

```bash
cp backend/config.ini.example ./config.ini   # then edit OIDC + hosts
SSH_DIR=~/.ssh docker compose up -d          # builds + runs on :8000
```

### Session secret (`SESSION_SECRET`) — important

`SESSION_SECRET` is the HMAC key used to sign the **session cookie** that holds
each logged-in user's OIDC tokens. **Set it explicitly** so sessions survive a
container restart; otherwise a **random one is generated at each process start**,
which means every restart/redeploy logs everyone out (they have to re-authenticate
through the IdP). The app still works without it, but it's not recommended for
anything beyond a quick local test.

Generate a strong value and pass it in:

```bash
# plain docker
docker run -d --name webvirt -p 8000:8000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v "$(pwd)/config.ini:/app/config.ini:ro" \
  -v "$HOME/.ssh:/root/.ssh:ro" webvirt

# docker compose (add to the `environment:` list, or export first)
export SESSION_SECRET="$(openssl rand -hex 32)"
SESSION_SECRET=$SESSION_SECRET docker compose up -d
```

```yaml
# or, in docker-compose.yml:
    environment:
      - SESSION_SECRET=${SESSION_SECRET}
```

> Note: the container runs a single uvicorn worker, so an in-memory fallback is
> safe, but a stable `SESSION_SECRET` is still the right call — it keeps users
> logged in across restarts and is required if you ever scale to >1 worker.

### With plain `docker`

```bash
docker build -t webvirt .
docker run -d --name webvirt \
  -p 8000:8000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v "$(pwd)/config.ini:/app/config.ini:ro" \
  -v "$HOME/.ssh:/root/.ssh:ro" \
  webvirt
```

### Auth disabled (trusted internal network only)

```bash
docker run -d --name webvirt \
  -p 8000:8000 \
  -e OIDC_ENABLED=false \
  -v "$(pwd)/config.ini:/app/config.ini:ro" \
  -v "$HOME/.ssh:/root/.ssh:ro" \
  webvirt
```

### Local development (no container)

```bash
# 1. backend (FastAPI, port 8000)
cd backend
pip install -r requirements.txt      # needs libvirt-dev system package for libvirt-python
CONFIG_PATH=./config.ini python -m uvicorn app.main:app --port 8000 --reload

# 2. frontend (Vite dev server, proxies /api and /vnc to :8000)
cd frontend
bun install && bun run dev            # http://localhost:5173
```

---

## SSH to the hypervisors

`qemu+ssh://root@node01/system` makes libvirt shell out to `ssh`. The container
needs non-interactive SSH access to each hypervisor as the configured user:

- Mount your SSH key (`~/.ssh`) read-only into `/root/.ssh` (see the run commands).
- The key must be authorized on each host (e.g. `root@node01`'s `authorized_keys`).
- `StrictHostKeyChecking=accept-new` is used for the per-session VNC tunnels so
  first-connect prompts don't block. For libvirt's own connections, seed
  `~/.ssh/known_hosts` once (`ssh root@node01 true`).

---

## API (authed when OIDC enabled)

| Method | Path                                         | Purpose                                    |
|--------|----------------------------------------------|--------------------------------------------|
| GET    | `/api/me`                                     | Current user + groups (or `auth_enabled:false`) |
| GET    | `/api/healthz`                                | Liveness + config summary (public)         |
| GET    | `/api/hosts`                                  | All hosts with reachability                |
| GET    | `/api/hosts/{host}`                           | Single host detail                         |
| GET    | `/api/hosts/{host}/vms`                       | VMs (domains) with power state             |
| GET    | `/api/hosts/{host}/vms/{vm}`                  | Single VM info                             |
| GET    | `/api/hosts/{host}/vms/{vm}/stats`            | CPU / RAM / Disk / Network counters        |
| POST   | `/api/hosts/{host}/vms/{vm}/{action}`         | `power-on`, `power-off`, `soft-shutdown`, `soft-reboot`, `hard-reset` |
| POST   | `/api/hosts/{host}/vms/{vm}/vnc`              | Create a VNC session → `{token, path}`     |
| WS     | `/vnc/ws/{token}`                             | WebSocket-to-VNC relay (noVNC connects here) |
| POST   | `/api/config/reload`                          | Reload the INI config without restart     |

---

## Project layout

```
.
├── Dockerfile                 # multi-stage: frontend build + backend (libvirt) runtime
├── docker-compose.yml
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI app, conditional auth, SPA serving
│   │   ├── config.py          # INI parsing + reload + env overrides
│   │   ├── oidc.py            # discovery, PKCE, token exchange, refresh, logout URL
│   │   ├── auth.py            # session store, signed cookie, middleware, /login /callback /logout /api/me
│   │   ├── libvirt_api.py    # connection pool, host/VM/stats/actions, VNC info
│   │   ├── vnc_proxy.py       # SSH tunnel + WS↔TCP pump (websockify-equivalent)
│   │   └── routes.py          # REST routes
│   ├── requirements.txt
│   └── config.ini.example
├── frontend/                  # Vite + React + TS
│   ├── src/
│   │   ├── App.tsx            # dashboard (hosts sidebar + VM table)
│   │   ├── api.ts             # typed API client
│   │   ├── components/        # HostSidebar, VmTable, VmStatsSheet, VncConsole, UserMenu
│   │   ├── hooks/usePolling.ts
│   │   └── components/ui/      # minimal shadcn-style primitives
│   └── ...
└── src/                       # Next.js sandbox preview of the same UI (mock data)
```
