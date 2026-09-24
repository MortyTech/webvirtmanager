"use client";

import * as React from "react";
import {
  Boxes,
  Container,
  KeyRound,
  Lock,
  ShieldAlert,
  Terminal,
  FileCog,
  Network,
  Server,
  MonitorPlay,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";

const CONFIG_INI = `[oidc]
# Toggle the entire OIDC flow. Default is "true" (secure-by-default).
# Set to "false" ONLY on trusted internal networks where no login is desired.
enabled = true

issuer = https://keycloak.example.com/realms/example
client_id = my-client-id
client_secret = my-client-secret        ; omit this line entirely for public (PKCE) clients
client_type = confidential                ; or "public"
redirect_url = https://adc.example.com/oauth2/callback
backend_logout_url = https://keycloak.example.com/realms/example/protocol/openid-connect/logout
scope = "openid profile email"
oidc_groups_claim = groups

[hosts]
node01 = qemu+ssh://root@node01/system
node02 = qemu+ssh://root@node02/system
node03 = qemu+ssh://root@node03/system`;

const DOCKERFILE_SNIPPET = `# Build
docker build -t webvirt .

# Run (confidential OIDC, default secure mode)
docker run -d --name webvirt \\
  -p 8000:8000 \\
  -v "$(pwd)/config.ini:/app/config.ini:ro" \\
  -v "$HOME/.ssh:/root/.ssh:ro" \\
  webvirt

# Run (auth disabled — trusted internal network only)
docker run -d --name webvirt \\
  -p 8000:8000 \\
  -e OIDC_ENABLED=false \\
  -v "$(pwd)/config.ini:/app/config.ini:ro" \\
  -v "$HOME/.ssh:/root/.ssh:ro" \\
  webvirt`;

function CodeBlock({ code, lang = "ini" }: { code: string; lang?: string }) {
  return (
    <div className="rounded-lg border bg-zinc-950 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        <span className="ml-2 text-[11px] text-zinc-400 font-mono">{lang}</span>
      </div>
      <pre className="p-4 text-[12.5px] leading-relaxed font-mono text-zinc-100 overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function FeatureRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <ArrowRight className="h-3.5 w-3.5 mt-1 text-emerald-600 shrink-0" />
      <span className="text-muted-foreground">{children}</span>
    </li>
  );
}

export function ConfigView() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileCog className="h-4 w-4" /> Single INI configuration file
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            All configuration — OIDC settings and the list of hosts — lives in one INI file the backend
            reads on startup. Adding or removing a host is a one-line edit. OIDC config changes never touch
            the UI — there is no admin dashboard, just the host/VM view.
          </p>
          <p className="text-sm text-muted-foreground">
            The file is re-read on <code className="text-xs bg-muted px-1 py-0.5 rounded">SIGHUP</code> (and
            via a <code className="text-xs bg-muted px-1 py-0.5 rounded">POST /api/config/reload</code> admin
            endpoint) so most changes take effect without a full restart.
          </p>
          <Separator />
          <ul className="space-y-1.5">
            <FeatureRow><code className="text-xs">enabled</code> defaults to <strong>true</strong> (secure-by-default) — only disable on trusted networks.</FeatureRow>
            <FeatureRow><code className="text-xs">redirect_url</code> is taken verbatim — never derived from the Host header.</FeatureRow>
            <FeatureRow><code className="text-xs">client_secret</code> is omitted entirely for public (PKCE) clients.</FeatureRow>
            <FeatureRow><code className="text-xs">scope</code> and <code className="text-xs">oidc_groups_claim</code> are read from file, never hardcoded.</FeatureRow>
          </ul>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <CodeBlock code={CONFIG_INI} lang="config.ini" />
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>enabled = false disables all access control</AlertTitle>
          <AlertDescription>
            When OIDC is disabled the app skips the entire auth flow, registers no callback route, and serves
            the dashboard unauthenticated. <strong>Only use this on trusted internal networks.</strong> When
            enabled (the default), the auto-redirect Authorization Code flow protects every route.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}

function ArchBox({
  icon: Icon,
  title,
  sub,
  color,
}: {
  icon: React.ElementType;
  title: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 flex flex-col items-center text-center gap-1.5">
      <Icon className={`h-5 w-5 ${color}`} />
      <div className="text-xs font-medium">{title}</div>
      <div className="text-[11px] text-muted-foreground leading-tight">{sub}</div>
    </div>
  );
}

export function ArchitectureView() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Boxes className="h-4 w-4" /> End-to-end data flow
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3 items-stretch">
            <ArchBox icon={MonitorPlay} title="Browser" sub="React + TS (Vite) UI · noVNC client" color="text-emerald-600" />
            <ArchBox icon={Server} title="FastAPI backend" sub="REST API · OIDC · WebSocket-to-VNC proxy" color="text-violet-600" />
            <ArchBox icon={Network} title="libvirt hosts" sub="qemu+ssh:// · VNC listener on 127.0.0.1" color="text-sky-600" />
          </div>
          <div className="mt-3 text-[12px] text-muted-foreground font-mono text-center">
            HTTPS/WSS → FastAPI (:8000) ── OIDC-gated ──→ libvirt (qemu+ssh) ──→ QEMU/KVM + VNC
          </div>
          <Separator className="my-4" />
          <ul className="space-y-1.5">
            <FeatureRow><strong>Auth:</strong> auto-redirect to IdP (no login page). Confidential = secret; public = PKCE. Discovery-driven endpoints, refresh-token rotation, RP-initiated logout.</FeatureRow>
            <FeatureRow><strong>Hosts:</strong> reachability probed via libvirt openReadOnly; per-host VM list with live power state.</FeatureRow>
            <FeatureRow><strong>Stats:</strong> libvirt domstats / dommemstat / domblkstat / domifstat; cumulative values returned, rates computed client-side.</FeatureRow>
            <FeatureRow><strong>VNC:</strong> backend opens an SSH tunnel to the VM's VNC port and bridges the TCP stream to a WebSocket (websockify-equivalent); noVNC connects on the same origin.</FeatureRow>
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="h-4 w-4" /> OIDC, both client types
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              <FeatureRow>Confidential: Authorization Code + client_secret in token exchange (server-side only).</FeatureRow>
              <FeatureRow>Public: Authorization Code + PKCE (S256), no secret anywhere.</FeatureRow>
              <FeatureRow>Discovery at <code className="text-xs">{`{issuer}/.well-known/openid-configuration`}</code> resolves auth/token/userinfo/end-session.</FeatureRow>
              <FeatureRow>Expired access tokens auto-refresh via refresh_token; failure → re-authenticate.</FeatureRow>
              <FeatureRow>Groups claim (<code className="text-xs">oidc_groups_claim</code>) stored in session, exposed at <code className="text-xs">/api/me</code>.</FeatureRow>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Lock className="h-4 w-4" /> Session & logout
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              <FeatureRow>Stateless httpOnly session cookie (signed); tokens kept server-side, never exposed to JS.</FeatureRow>
              <FeatureRow>Logout destroys the local session <strong>and</strong> redirects to the IdP end-session endpoint with <code className="text-xs">id_token_hint</code>.</FeatureRow>
              <FeatureRow><code className="text-xs">post_logout_redirect_uri</code> returns the user to the app, which immediately re-triggers login.</FeatureRow>
              <FeatureRow>Falls back to explicit <code className="text-xs">backend_logout_url</code> if discovery has no end-session endpoint.</FeatureRow>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function DeployView() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Container className="h-4 w-4" /> Build &amp; run the container
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The repo ships a multi-stage <code className="text-xs bg-muted px-1 py-0.5 rounded">Dockerfile</code>:
            stage 1 builds the Vite React frontend, stage 2 installs libvirt system libraries + Python deps,
            copies the compiled frontend into FastAPI's static directory, and serves everything on a single port
            <code className="text-xs bg-muted px-1 py-0.5 rounded"> 8000</code>.
          </p>
          <CodeBlock code={DOCKERFILE_SNIPPET} lang="shell" />
          <Alert>
            <Terminal className="h-4 w-4" />
            <AlertTitle>SSH trust to hosts</AlertTitle>
            <AlertDescription>
              Mount your <code className="text-xs">~/.ssh</code> (or a dedicated key) read-only into the
              container so libvirt's <code className="text-xs">qemu+ssh://</code> transport can reach the
              hypervisors non-interactively.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Badge variant="secondary" className="text-[10px]">single port</Badge>
            What runs inside
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5">
            <FeatureRow><strong>uvicorn</strong> (1 worker) — FastAPI app: REST API + OIDC + static frontend.</FeatureRow>
            <FeatureRow><strong>WebSocket route</strong> <code className="text-xs">/vnc/ws/{`{token}`}</code> — bridges noVNC to an SSH-tunneled VNC TCP socket.</FeatureRow>
            <FeatureRow><strong>libvirt-python</strong> — connection pooling per host (qemu+ssh).</FeatureRow>
            <FeatureRow><strong>openssh-client</strong> — for the qemu+ssh transport and per-session VNC tunnels.</FeatureRow>
            <FeatureRow>No database, no scheduler — the frontend drives polling (≥10s).</FeatureRow>
          </ul>
          <Separator className="my-3" />
          <p className="text-xs text-muted-foreground">
            Exposed volume <code className="text-xs">/app/config.ini</code> holds OIDC + hosts. Environment
            override <code className="text-xs">OIDC_ENABLED=false</code> toggles auth without editing the file.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
