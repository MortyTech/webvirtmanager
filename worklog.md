# Worklog — Web virt-manager (FastAPI + React + libvirt + noVNC)

This is the shared worklog. All agents append below using the `---` separator.

Project goal: a Dockerized web app like `virt-manager`:
- Backend: Python + FastAPI, libvirt-python (qemu+ssh only), WebSocket-to-VNC proxy.
- Frontend: React + TypeScript (Vite) with noVNC.
- Auth: OIDC (confidential + public/PKCE), auto-redirect, no login page, optional `enabled=false` toggle.
- Config: single INI file (OIDC + hosts), reloadable.
- No database. Single dashboard. Must ship a working Dockerfile.

Sandbox note: libvirt is NOT installed here (Docker is the real target). The Next.js app on :3000 serves as a live, interactive UI preview/mockup of the dashboard; the real deployable app lives in `backend/` and `frontend/`.

---
Task ID: all
Agent: main (Z.ai Code)
Task: Build the full Dockerized web virt-manager (FastAPI + React + libvirt + noVNC + OIDC) plus a Next.js sandbox preview.

Work Log:
- Inspected environment: FastAPI/uvicorn/httpx/PyJWT/websockets present; libvirt NOT installed (expected — Docker is the target).
- Built Next.js interactive preview in src/app/page.tsx + src/components/showcase/ (dashboard mockup with hosts/VMs, live stats polling sim, VNC console mockup, config reference, architecture, deploy instructions). Sticky footer verified.
- Built backend/ (FastAPI):
  - config.py: single INI parser + reload + env overrides (OIDC_ENABLED, CONFIG_PATH, SESSION_SECRET, STATIC_DIR). enabled defaults to true (secure-by-default).
  - oidc.py: discovery-driven; PKCE (S256) for public clients, client_secret for confidential; token exchange/refresh; ID-token decode + groups extraction; RP-initiated logout URL with id_token_hint + post_logout_redirect_uri.
  - auth.py: in-memory session store + HMAC-signed httpOnly cookie; conditional AuthMiddleware (skips when disabled, gates /api with 401 and browser routes with 302→/login, skips /vnc/ so the WS endpoint enforces session itself); /login, /oauth2/callback (state + PKCE verifier check), /logout, /api/me (always mounted so frontend can detect auth mode).
  - libvirt_api.py: lazy import (app boots without libvirt); per-host pooled RW connection + lock; host_status, list_vms, power_on/off/soft_shutdown/soft_reboot/hard_reset, vm_stats (dom.info, dom.memoryStats, dom.blockStats, dom.interfaceStats), vm_vnc_info (parse XML for VNC port/listen).
  - vnc_proxy.py: SSH tunnel subprocess (ssh -N -L) + asyncio WS<->TCP binary pump = websockify-equivalent, single port, token-bound + session-bound.
  - routes.py + main.py: REST routes, conditional middleware, SPA static serving + fallback, /api/nonexistent → 404 JSON (not swallowed), healthcheck, SIGHUP + POST /api/config/reload.
  - Verified backend boots in sandbox: /healthz 200, /api/me {auth_enabled:false}, /api/hosts returns libvirt-unavailable per host, /api/config/reload 200, OIDC-enabled mode: GET / → 302 /login, /api/hosts → 401, /oauth2/callback?state=y → 400 invalid state, /healthz public 200.
- Built frontend/ (Vite + React + TS + Tailwind v4 + Radix UI primitives): api.ts typed client, usePolling hook (min 10s, default 30s, client-side), HostSidebar, VmTable (state-aware action gating), VmStatsSheet (delta-rate computation + recharts), VncConsole (dynamic noVNC RFB import, WS URL same-origin, password prompt), UserMenu, Toaster. Build passes (tsc -b + vite build), RFB chunk lazy-split.
- Verified full serving path: copied frontend dist → backend/static, ran uvicorn: GET / serves index.html, /assets/* served, /api/me disabled, /api/nonexistent 404 JSON, SPA fallback 200.
- Wrote multi-stage Dockerfile (oven/bun frontend build → python:3.12-slim builder with libvirt-dev → runtime with libvirt0+openssh-client, single port 8000, venv copy, healthcheck, uvicorn --workers 1), .dockerignore, docker-compose.yml, README (architecture, OIDC flows, enabled=false trusted-network warning, docker run/compose, API table, layout).
- Cleaned ESLint config to ignore backend/** and frontend/** (minified bundles were tripping react-hooks rule); lint now clean.
- Removed test artifacts (backend/config.ini, backend/static, frontend/dist) — Dockerfile regenerates them.

Stage Summary:
- Next.js showcase (the only user-visible / route) verified end-to-end with Agent Browser: renders, tabs work (Dashboard/Configuration/Architecture/Deploy), host switching, VNC console dialog with boot log, stats sheet with live values + 30s default interval, sticky footer on short + long pages, mobile responsive.
- No runtime/hydration errors; dev.log clean; bun run lint clean.
- Real deliverable = Dockerized app in backend/ + frontend/ + Dockerfile + docker-compose.yml + README. libvirt is a Docker-runtime dependency (not present in sandbox); OIDC + config + SPA serving + VNC proxy logic all verified.

---
Task ID: bugfix-1
Agent: main (Z.ai Code)
Task: Fix "host connected but no VMs shown" — virsh lists 3 domains but the app shows none.

Work Log:
- Diagnosed: in backend/app/libvirt_api.py list_vms(), the per-domain dict literal called `dom.autostartEnabled()` — which is NOT a real libvirt-python method (`virDomainGetAutostart` is exposed as `dom.autostart()`). The AttributeError fired inside the dict literal before `out.append(...)` completed, was swallowed by `except Exception: continue`, and silently dropped EVERY domain → empty list → "No domains defined" despite a reachable host.
- Fixed list_vms():
  * Added a `_call(obj, primary, *fallbacks, default=...)` helper that tries the real method name plus fallbacks and never raises.
  * Essential fields (name/uuid/state/info) gathered via _call; a VM is skipped only if `name` can't be read.
  * Non-essential fields (autostart/persistent) are best-effort — a missing method can never drop a VM again.
  * Made listAllDomains flags explicit (ACTIVE | INACTIVE) for clarity.
  * Verified the real method names used elsewhere (create/destroy/shutdownFlags/shutdown/reset/reboot/info/state/memoryStats/XMLDesc/blockStats/blockInfo/interfaceStats, conn.getHostname/getInfo/numOfDomains) are all correct libvirt-python names.
- Verified the fix with a mock domain exposing `autostart()` (not `autostartEnabled()`): the VM is now returned with state=running, vcpu=2, autostart=True, instead of being dropped. Module imports cleanly (HAS_LIBVIRT=False in sandbox, but logic path exercised).

Stage Summary:
- Root cause: wrong libvirt-python method name (`autostartEnabled` vs `autostart`) inside a try/except that swallowed it, dropping all VMs.
- Fix in backend/app/libvirt_api.py. User must rebuild the image: `docker compose build && docker compose up -d --force-recreate` (frontend layer is cached; only the backend app copy layer onward reruns — fast).

---
Task ID: bugfix-2
Agent: main (Z.ai Code)
Task: Fix the batch of bugs visible in the user's 3 screenshots (dashboard, stats drawer, VNC console).

Work Log:
- VNC "unknown action: vnc": root cause = FastAPI route ordering. POST /hosts/{host}/vms/{vm}/{action} was registered BEFORE POST .../vnc, so Starlette matched "vnc" as an {action} param first -> 404. Reordered routes.py so .../vnc is registered before .../{action}. Verified /vnc is now route index 5, /{action} index 6.
- VM memory shown as TiB (48/16/8 TiB): formatKiB() threshold bug — 1024*1024 KiB is 1 GiB, not 1 TiB. Fixed thresholds: TiB=1024^3, GiB=1024^2, MiB=1024. Now 48 GiB -> "48 GiB".
- Host memory "0 GiB": getInfo() memory field unreliable on these builds. Added _host_memory_kib(conn) that prefers virNodeGetMemoryStats('total') (KiB, matches /proc/meminfo) with getInfo fallback. HostSidebar now uses formatKiB() (consistent units).
- Unrounded floats (947.2149857337799 B/s): formatBytes() <1024 branch returned raw float. Fixed to Math.round. Now 947 B/s.
- Charts looked cumulative (linear ramp from 0): first sample had no previous point so it pushed a zero history point, then rose to the real rate. Fixed: on first sample, store baseline and DON'T push a point; chart starts at the first real rate.
- Memory at 100%: dom.info() memory (balloon current) == max when not ballooned. Switched the "used" metric to memory_stats.rss (resident) when available, else actual-unused, else memory_kib. Shows realistic % of max.
- Stats screen too small: rewrote VmStatsSheet from a narrow 512px side Sheet to a large centered Dialog (96vw / 90vh, max-w-5xl) with bigger stat cards and taller (160px) 2-col charts.
- VM state badges not aligned: badges had varying widths, left-aligned -> ragged. Made them fixed-width (w-20) centered pills with whitespace-nowrap; widened state column to 100px; right-aligned vCPU/Memory; added min-w-0 to name for clean truncation.
- vm_vnc_info: treat port<0 (autoport unassigned / domain not running) as 0 (no VNC) so create_vnc_session rejects cleanly.
- Verified: backend imports clean, /vnc before /{action}, frontend `bun run build` passes (tsc + vite), formatter math proven (48 GiB, 256 GiB, 947 B/s).

Stage Summary:
- 6 distinct bugs fixed across backend (libvirt_api.py, routes.py, vnc_proxy via vm_vnc_info) and frontend (utils.ts, HostSidebar, VmTable, VmStatsSheet).
- User must rebuild: `docker compose build && docker compose up -d --force-recreate` (frontend rebuilds; backend Python + frontend copied into image).
- VNC should now open (route fixed; user's VNC XML listen=172.16.21.13 autoport=yes -> live XML gives real port, SSH tunnel to that addr:port).

---
Task ID: bugfix-3
Agent: main (Z.ai Code)
Task: Fix STATE column misalignment + VNC "VNC session disconnected" (tunnel/handshake failure).

Work Log:
- STATE alignment: badges were centered (w-20) while the narrow "STATE" header text was centered too, so the badge's left edge sat left of the header's left edge -> looked misaligned. Switched both header and the state cell to LEFT-alignment (header left, cell `flex justify-start`, badge stays fixed w-20 with centered content). Now badge left edge == header left edge == cell left edge; all rows' badges share the same left edge.
- VNC disconnect root cause: create_vnc_session returned a token after only a 0.4s fixed sleep — too short for the SSH control connection + local forward to bind. noVNC then connected via the WS pump to a not-yet-ready local port -> TCP refused/EOF -> pump closed the WS -> noVNC fired `disconnect` (detail.password=false) -> "VNC session disconnected". The VM was fine; the proxy layer raced.
- Hardened vnc_proxy.py:
  * _spawn_tunnel: replaced the fixed 0.4s sleep with a real readiness poll — retry TCP connect to 127.0.0.1:local_port for up to 8s; if ssh exits first, surface its stderr; if timeout, raise a clear "tunnel did not become ready" error.
  * Added _probe_vnc(): after the tunnel is up, open a THROWAWAY connection to the local port and read the first 13 bytes — must start with "RFB " (real VNC server greeting). VNC servers accept multiple concurrent clients, so the noVNC session later opens its own fresh connection and the server re-sends the greeting. This verifies end-to-end: ssh auth OK + forward bound + remote listen addr reachable + a real VNC server on that port.
  * create_vnc_session now probes BEFORE handing out a token; on probe failure it kills the tunnel and raises a specific RuntimeError -> the POST /api/hosts/{host}/vms/{vm}/vnc returns 409 with a clear reason (e.g. "VNC unreachable on turin3 (vnc_port=5901, listen=172.16.21.13): ...") instead of the frontend showing a generic WS disconnect.
  * Added print(...flush=True) logging at every step (spawn, probe ok, session created, ws connect, tcp connect fail, ws ended) so `docker logs webvirt` shows the full chain.
- The user's VNC XML (listen='172.16.21.13', autoport='yes') is handled correctly: vm_vnc_info parses the LIVE XML of the running domain (real port 5900+N, not -1), and the SSH tunnel targets listen_addr:vnc_port from the remote host (172.16.21.13 is turin3's own NIC, so turin3 can reach it).
- Verified: backend imports OK (_probe_vnc present), frontend `bun run build` passes.

Stage Summary:
- STATE column now left-aligned with fixed-width badges -> aligned.
- VNC: the proxy now either successfully reaches a verified VNC server (noVNC connects) or fails at the POST with a concrete error message visible in the modal + `docker logs webvirt`. The previous race (token handed out before the tunnel was ready) is eliminated.
- User must rebuild: `docker compose build && docker compose up -d --force-recreate`. After rebuild, if VNC still fails, the modal will now show the REAL reason (e.g. ssh auth, tunnel timeout, no RFB greeting) and `docker logs webvirt` will have the [vnc] trace.

---
Task ID: bugfix-4
Agent: main (Z.ai Code)
Task: VNC console size + toolbar (Ctrl+Alt+Del, Fit, Fullscreen), sort VMs by Name/State, STATE alignment beside name.

Work Log:
- VNC console (VncConsole.tsx): made the modal bigger (96vw / 88vh, max-w-6xl, flex-col). Console area is now flex-1 (fills the modal) and is the native-fullscreen target. Added a toolbar with 3 buttons:
  * Ctrl+Alt+Del -> rfb.sendCtrlAltDel() (disabled until connected).
  * Fit / 1:1 -> toggles rfb.scaleViewport (Fit = scaled to window; 1:1 = native resolution).
  * Fullscreen -> consoleAreaRef.requestFullscreen() (native Fullscreen API; exits via Esc/F11 like any tab). Tracks fullscreenchange to swap Expand/Shrink icon. Closing the dialog also exits native fullscreen.
- Extended novnc.d.ts RfbInstance with sendCtrlAltDel().
- VM sorting (VmTable.tsx): NAME and STATE column headers are now clickable buttons; clicking toggles asc/desc (chevron rotates), clicking the other column switches the sort key. Sorts: by name (localeCompare) or by state (power-state priority: running < paused < suspended < blocked < shutdown < stopped < crashed, then name within same state).
- STATE alignment: moved STATE right beside the NAME by changing the NAME column from 1fr (expands, pushes state away) to auto (shrinks to content, capped at 240px with truncate). Grid is now [auto_104px_56px_88px_1fr] (ACTIONS=1fr absorbs slack, buttons right-aligned). STATE cell left-aligned (flex justify-start), badge fixed w-20. So the state badge sits immediately after the VM name on the left side of the row.
- Verified: frontend `bun run build` passes (tsc + vite), Next.js `bun run lint` clean, dev server compiles.

Stage Summary:
- VNC console: bigger, with Ctrl+Alt+Del, Fit/1:1, and native Fullscreen (Esc/F11 exit).
- VM table: clickable Name/State sort headers; STATE badge now sits directly beside the VM name (left side), left-aligned.
- User rebuilds: `docker compose build && docker compose up -d --force-recreate`.

---
Task ID: bugfix-5
Agent: main (Z.ai Code)
Task: Fix inconsistent VM-table column alignment (NAME/STATE/vCPU/MEMORY misaligned across rows; ACTIONS aligned).

Root cause:
- VmTable rendered each row as its OWN CSS grid (grid-cols-[auto_...]). An `auto` NAME column resolves independently PER ROW to that row's name width, so a short name ("jira") gave a narrow NAME cell and a long name ("mailserver") a wider one -> STATE/vCPU/MEMORY started at different x per row. ACTIONS looked aligned only because it was 1fr + justify-end (always pinned to the right edge).

Fix:
- Converted VmTable to a real <table> with table-layout:auto (default). A table sizes each column to the WIDEST cell across ALL rows (header + data), so column widths are consistent across every row BY DEFINITION. STATE ends up right beside the longest name; long names truncate at max-w-[260px]. Kept the clickable sortable Name/State headers (th buttons + chevron). Wrapped in overflow-x-auto for narrow screens.
- Verified: frontend `bun run build` passes.

Stage Summary:
- VM table columns now align vertically across all rows (single shared column structure via <table>), header included. Sortable Name/State retained. Rebuild: `docker compose build && docker compose up -d --force-recreate`.

---
Task ID: bugfix-6
Agent: main (Z.ai Code)
Task: Add "Maximize"/"Fill Window" mode to the VNC console (expand modal to full viewport, keep browser chrome visible).

Work Log:
- Added isMaximized state to VncConsole (separate from isFullscreen / fit).
- toggleMaximize(): flips the state, then after a 60ms layout delay re-assigns rfb.scaleViewport=fit (noVNC's setter calls _updateScale) and dispatches a window resize event — so the noVNC canvas rescales to the new container size when switching between centered and full-viewport.
- contentClass: when maximized, DialogContent gets `fixed inset-0 left-0 top-0 right-0 bottom-0 z-50 w-screen h-screen max-w-none translate-x-0 translate-y-0 p-0 rounded-none sm:rounded-none overflow-hidden gap-0 flex flex-col` — twMerge overrides the dialog base's centering (left-1/2/top-1/2/-translate-x-.../max-w-lg/p-6/gap-4/grid/sm:rounded-lg). When not maximized, the original centered modal classes are unchanged (sm:max-w-6xl w-[96vw] h-[88vh]).
- New "Maximize" button placed BETWEEN Fit and Fullscreen in the toolbar (Maximize2/Minimize2 icons; label toggles Maximize/Restore; ml-auto pushes it + Fullscreen to the right cluster).
- Preserved exactly: Fullscreen (native Fullscreen API, Esc/F11 exit), Fit (1:1 vs scaled, scaleViewport), Ctrl+Alt+Del (sendCtrlAltDel), "Esc to exit fullscreen" hint, centered modal when not maximized, dialog X close.
- Verified: frontend `bun run build` passes.

Stage Summary:
- VNC console now has 3 toolbar buttons: Ctrl+Alt+Del | Fit | Maximize | Fullscreen. Maximize fills the browser viewport (fixed inset-0) WITHOUT browser fullscreen (chrome stays visible); click again to restore centered modal. Fit keeps working inside maximized view. Rebuild: `docker compose build && docker compose up -d --force-recreate`.

---
Task ID: bugfix-7
Agent: main (Z.ai Code)
Task: Rename Hard Power Off -> Stop; add "Edit XML" (virsh edit equivalent) feature.

Work Log:
- VmTable: renamed the hard-power-off button to "Stop" — icon changed from Power to Square (fill-current, stop symbol), tooltip "Stop (force power off)". Applied to both the running-VM and paused-VM hard-off buttons. The backend action stays "power-off" (virDomainDestroy); only the UI changed.
- Backend XML editor (virsh edit equivalent):
  * libvirt_api.py: vm_xml(host, vm) returns the domain XML for editing (prefers VIR_DOMAIN_XML_INACTIVE|SECURE = the persistent definition that virsh edit shows and virDomainDefineXML updates; falls back to live XML for transient domains). vm_define_xml(host, vm, xml) does a server-side ET.fromstring well-formedness check, then conn.defineXML(xml) (virDomainDefineXML). Malformed XML raises ValueError; libvirt rejection raises RuntimeError — both surfaced as 400 so the editor stays open with the user's text.
  * routes.py: GET /api/hosts/{host}/vms/{vm}/xml and PUT /api/hosts/{host}/vms/{vm}/xml (Body={xml}). PUT returns 400 with the parse/libvirt error detail on failure, {ok, name} on success.
- Frontend XML editor:
  * api.ts: getXml() + saveXml().
  * XmlEditor.tsx: large dialog (96vw/88vh) with @uiw/react-codemirror + @codemirror/lang-xml (line numbers, XML syntax highlighting, fold gutter, dark theme). Loads XML on open. Save flow: client-side DOMParser well-formedness check first (never sends broken XML); then PUT; on 400 shows the libvirt error in a red banner and KEEPS the editor open with the user's changes intact; on success toasts + closes. "unsaved" indicator in header. Disabled Save button until dirty.
  * VmTable: added an "Edit XML" outline button (FileCode icon, tooltip "Edit XML (virsh edit)") in both running and stopped action rows.
  * App.tsx: wired xmlVm/xmlOpen state + onEditXml handler + rendered <XmlEditor>.
- Installed deps: @uiw/react-codemirror, @codemirror/lang-xml (bun.lock updated).
- Verified: backend imports OK, frontend `bun run build` passes, Next.js `bun run lint` clean.

Stage Summary:
- Stop button replaces Hard Power Off (Square icon, "Stop (force power off)" tooltip).
- New "Edit XML" button opens a CodeMirror editor (XML highlight + line numbers) backed by virDomainGetXMLDesc(INACTIVE|SECURE) / virDomainDefineXML — behaves like virsh edit: invalid or libvirt-rejected XML is NOT saved, the editor stays open with the error and the user's text. Rebuild: `docker compose build && docker compose up -d --force-recreate`.

---
Task ID: bugfix-8
Agent: main (Z.ai Code)
Task: Add [vnc] mode = ssh|direct config — direct mode connects the WS-to-VNC proxy straight to the host's VNC port (no SSH tunnel); ssh stays the default.

Work Log:
- config.py: added VncConfig(mode="ssh" default, is_direct property) + Config.vnc; parse [vnc] section's `mode` (validates to ssh/direct, invalid -> ssh default).
- vnc_proxy.py:
  * Generalized _probe_vnc -> _probe_vnc_host(target_host, target_port) (works for 127.0.0.1:local in ssh mode and <host>:<port> in direct mode).
  * Added _direct_target_host(uri, listen): uses the VNC `listen` address from the live XML; wildcard (0.0.0.0/::/*) -> hypervisor hostname from the URI; 127.0.0.1/::1/localhost -> raises a clear error (container can't reach the host's loopback in direct mode).
  * Refactored create_vnc_session to branch on get_config().vnc.mode: direct -> no SSH tunnel, target=<resolved host>:<vnc port>, probe it; ssh (default) -> spawn tunnel, target=127.0.0.1:<local>, probe it. Unified session dict now stores target_host/target_port/ssh_proc(None in direct)/mode. POST returns {token, path, vnc_port, mode}.
  * WS endpoint: connects to entry["target_host"]:entry["target_port"] (works for both modes); only checks ssh_proc.poll() when ssh_proc is not None (direct mode has no proc). Logs include mode + target.
- config.ini.example + README: documented [vnc] mode = ssh|direct with the reachable-bind requirement for direct mode.
- Verified: backend imports OK, config parses direct/ssh/invalid correctly, _direct_target_host resolves 172.16.21.13->itself / 0.0.0.0->turin3 / 127.0.0.1->raises, backend boots (healthz 200), Next.js lint clean.

Stage Summary:
- [vnc] mode = ssh (default, unchanged behavior) | direct (no SSH tunnel; container must reach the VNC port directly; VNC must be bound to a reachable address). Rebuild: `docker compose build && docker compose up -d --force-recreate`. Reload live via POST /api/config/reload (no restart) to switch modes.

---
Task ID: bugfix-9
Agent: main (Z.ai Code)
Task: Add "Define VM from XML" feature (virsh define equivalent) — paste or upload a <domain> XML, validate, define on the host, show confirmation.

Work Log:
- Backend:
  * libvirt_api.py: define_domain_xml(host, xml) — ET.fromstring well-formedness check, then conn.defineXML(xml); returns {ok, name, uuid}. Malformed XML -> ValueError; libvirt rejection -> RuntimeError.
  * routes.py: POST /api/hosts/{host}/define-xml (Body {xml}) — mirrors virsh define: parse error or libvirt rejection -> 400 with detail so the dialog stays open; success -> {ok, name, uuid}.
- Frontend:
  * api.ts: defineXml(host, xml).
  * DefineVmDialog.tsx: large dialog (96vw/88vh) with CodeMirror (XML syntax highlighting, line numbers, fold gutter, placeholder). Three ways to provide XML: paste in the editor, "Upload file" (native file input accept .xml), drag-and-drop a .xml onto the editor area. "Template" button inserts a minimal <domain> stub. Define flow: client-side DOMParser well-formedness check first (never sends broken XML); then POST defineXml; on success -> toast "VM '<name>' defined successfully on host '<host>'" + onDefined() (refresh VM list) + close; on error -> red banner with the libvirt message, editor stays open with the user's text.
  * VmTable.tsx: added "Import XML" outline button (FileUp icon, tooltip "Define a new VM from XML (virsh define)") in the host card header, shown only when the host is reachable. New onImportXml prop.
  * App.tsx: extracted refreshVmList useCallback (used by the VM-list effect + as onDefined after a define), added defineOpen state, passed onImportXml, rendered <DefineVmDialog host open onOpenChange onDefined=refreshVmList>.
- Verified: backend imports OK + define-xml route registered, frontend `bun run build` passes, Next.js lint clean.

Stage Summary:
- New "Import XML" button in the VM table header opens a CodeMirror editor with paste/upload/drag-drop. Define runs virDomainDefineXML on the selected host (= virsh define). Invalid or libvirt-rejected XML is NOT defined — the dialog keeps the editor open with the exact libvirt error. On success: toast "VM '<name>' defined successfully on host '<host>'" and the VM list refreshes. Rebuild: `docker compose build && docker compose up -d --force-recreate`.

---
Task ID: bugfix-10
Agent: main (Z.ai Code)
Task: Add dark/light theme toggle + OIDC group-based access control (allowed_groups).

Work Log:
A) OIDC group-based access control (backend):
- config.py: OidcConfig.allowed_groups (list; [] = allow all). Parse [oidc] allowed_groups as comma-separated.
- auth.py callback: after extracting groups+username, if allowed_groups is non-empty: deny (fail closed) if the IdP returned NO groups claim; deny if the user's groups don't intersect allowed_groups; else allow. Empty/missing allowed_groups = allow all (backward compatible). Each denied attempt is logged: [auth] DENY user=... groups=... allowed_groups=... (or reason=no_groups_claim) for audit (visible in docker logs).
- auth.py: _auth_denied_page(msg) returns a styled HTML 403 page ("Access denied" + the reason + a "Switch account / log out" link to /logout). Returned at /oauth2/callback on denial so the user sees a clear message, not raw JSON.
- Verified the 4 branches: allow-all (empty), allow (intersect), DENY (no match), DENY (no groups claim). config parses 'Admins, DevOps,Infrastructure' -> ['Admins','DevOps','Infrastructure']; missing -> [].
- Documented allowed_groups in config.ini.example + README.

B) Dark/light theme toggle (frontend):
- index.html: inline anti-flash script applies the theme class on <html> before React loads (saved manual choice wins; else prefers-color-scheme; default light).
- hooks/useTheme.ts: theme state ('light'|'dark'); getInitial reads localStorage 'webvirt-theme' else prefers-color-scheme else light. useEffect applies .dark class + persists to localStorage. toggle() adds a transient .theme-anim class for a smooth animated switch.
- index.css: html/html.dark color-scheme; a scoped .theme-anim transition rule (background-color/border-color/color/fill/stroke 0.18s) active only during the toggle so everyday hover isn't slowed.
- components/ThemeToggle.tsx: outline icon button (Sun in dark mode, Moon in light) with title/aria-label.
- App.tsx: rendered <ThemeToggle/> in the header next to "Refresh hosts".
- The main dashboard (header, sidebar, VM table, stats) follows the theme; the VNC console + XML/Define editors keep their intentional dark chrome (consoles/editors are dark regardless).
- Verified: backend imports OK, frontend `bun run build` passes, Next.js lint clean.

Stage Summary:
- Theme: light by default (or OS dark if no manual choice); toggle in header; persists across refresh via localStorage; smooth 180ms transition; no flash (pre-React script).
- OIDC: [oidc] allowed_groups = A, B, C restricts login to those groups; empty/missing = allow all; no groups claim returned = deny (fail closed); denied attempts logged; clear HTML "Access denied" page. Rebuild: `docker compose build && docker compose up -d --force-recreate`.
