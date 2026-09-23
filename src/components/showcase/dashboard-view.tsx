"use client";

import * as React from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  MonitorPlay,
  Network,
  Play,
  Power,
  RotateCcw,
  RefreshCw,
  Server,
  Loader2,
  ChevronRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/* Types & mock data                                                  */
/* ------------------------------------------------------------------ */

type VmState = "running" | "stopped" | "paused";

interface VmStat {
  name: string;
  state: VmState;
  vcpu: number;
  memoryMiB: number;
  diskGiB: number;
  os: string;
}

interface HostStat {
  id: string;
  name: string;
  uri: string;
  reachable: boolean;
  hostname?: string;
  cpuModel?: string;
  cpus?: number;
  memoryGiB?: number;
  vms: VmStat[];
}

const HOSTS: HostStat[] = [
  {
    id: "node01",
    name: "node01",
    uri: "qemu+ssh://root@node01/system",
    reachable: true,
    hostname: "node01.cluster.local",
    cpuModel: "Intel Xeon Gold 6248R",
    cpus: 48,
    memoryGiB: 192,
    vms: [
      { name: "web-prod-01", state: "running", vcpu: 4, memoryMiB: 8192, diskGiB: 80, os: "debian-bookworm" },
      { name: "web-prod-02", state: "running", vcpu: 4, memoryMiB: 8192, diskGiB: 80, os: "debian-bookworm" },
      { name: "pg-primary", state: "running", vcpu: 8, memoryMiB: 32768, diskGiB: 500, os: "ubuntu-22.04" },
      { name: "bastion", state: "stopped", vcpu: 2, memoryMiB: 2048, diskGiB: 20, os: "alpine-3.20" },
      { name: "build-runner", state: "paused", vcpu: 4, memoryMiB: 16384, diskGiB: 120, os: "fedora-40" },
    ],
  },
  {
    id: "node02",
    name: "node02",
    uri: "qemu+ssh://root@node02/system",
    reachable: true,
    hostname: "node02.cluster.local",
    cpuModel: "AMD EPYC 7402P",
    cpus: 48,
    memoryGiB: 256,
    vms: [
      { name: "k8s-cp-01", state: "running", vcpu: 4, memoryMiB: 16384, diskGiB: 100, os: "flatcar" },
      { name: "k8s-cp-02", state: "running", vcpu: 4, memoryMiB: 16384, diskGiB: 100, os: "flatcar" },
      { name: "k8s-worker-01", state: "running", vcpu: 8, memoryMiB: 32768, diskGiB: 200, os: "flatcar" },
      { name: "monitoring", state: "stopped", vcpu: 2, memoryMiB: 4096, diskGiB: 40, os: "rocky-9" },
    ],
  },
  {
    id: "node03",
    name: "node03",
    uri: "qemu+ssh://root@node03/system",
    reachable: false,
    vms: [],
  },
];

const STATE_STYLES: Record<VmState, { label: string; cls: string; dot: string }> = {
  running: { label: "running", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  stopped: { label: "stopped", cls: "border-zinc-400/40 bg-zinc-400/10 text-zinc-500", dot: "bg-zinc-400" },
  paused: { label: "paused", cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
};

function fmtMiB(mib: number) {
  if (mib >= 1024) return `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GiB`;
  return `${mib} MiB`;
}

/* ------------------------------------------------------------------ */
/* Live (mock) stats hook                                            */
/* ------------------------------------------------------------------ */

interface LiveSample {
  t: number;
  cpuPct: number;
  memUsedMiB: number;
  netRxKbps: number;
  netTxKbps: number;
  diskRdKbps: number;
  diskWrKbps: number;
}

function randWalk(prev: number, min: number, max: number, step: number) {
  const next = prev + (Math.random() - 0.5) * step * 2;
  return Math.min(max, Math.max(min, next));
}

function useLiveStats(vm: VmStat | null, intervalSec: number) {
  const [history, setHistory] = React.useState<LiveSample[]>([]);
  const [latest, setLatest] = React.useState<LiveSample | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!vm) return;
    let seed: LiveSample = {
      t: Date.now(),
      cpuPct: 18,
      memUsedMiB: vm.memoryMiB * 0.4,
      netRxKbps: 240,
      netTxKbps: 90,
      diskRdKbps: 60,
      diskWrKbps: 30,
    };
    setHistory([seed]);
    setLatest(seed);
    setLoading(true);
    const t = setTimeout(() => setLoading(false), 250);

    const id = setInterval(() => {
      seed = {
        t: Date.now(),
        cpuPct: randWalk(seed.cpuPct, 1, 100, 8),
        memUsedMiB: randWalk(seed.memUsedMiB, vm.memoryMiB * 0.2, vm.memoryMiB * 0.95, vm.memoryMiB * 0.03),
        netRxKbps: randWalk(seed.netRxKbps, 10, 4000, 120),
        netTxKbps: randWalk(seed.netTxKbps, 5, 2500, 90),
        diskRdKbps: randWalk(seed.diskRdKbps, 0, 1500, 80),
        diskWrKbps: randWalk(seed.diskWrKbps, 0, 1200, 60),
      };
      setHistory((h) => [...h.slice(-29), seed]);
      setLatest(seed);
    }, intervalSec * 1000);

    return () => {
      clearInterval(id);
      clearTimeout(t);
    };
  }, [vm?.name, intervalSec]);

  return { history, latest, loading };
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                      */
/* ------------------------------------------------------------------ */

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className={`h-4 w-4 ${color}`} />
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function MiniArea({ data, dataKey, color }: { data: LiveSample[]; dataKey: keyof LiveSample; color: string }) {
  return (
    <div className="h-16 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`g-${String(dataKey)}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.5} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={`url(#g-${String(dataKey)})`} isAnimationActive={false} />
          <XAxis dataKey="t" hide />
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Tooltip
            contentStyle={{ fontSize: 11, borderRadius: 8, padding: "4px 8px" }}
            labelFormatter={() => ""}
            formatter={(v: number) => [Number(v).toFixed(1), ""]}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stats side sheet                                                  */
/* ------------------------------------------------------------------ */

function VmStatsSheet({
  vm,
  host,
  open,
  onOpenChange,
}: {
  vm: VmStat | null;
  host: HostStat | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [intervalSec, setIntervalSec] = React.useState(30);
  const { history, latest, loading } = useLiveStats(vm, intervalSec);

  const memPct = latest && vm ? (latest.memUsedMiB / vm.memoryMiB) * 100 : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col gap-4 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-emerald-600" />
            {vm?.name ?? "VM"}
          </SheetTitle>
          <SheetDescription>
            Live statistics — {host?.name ? `${host.name}` : "—"} · polling controlled client-side
          </SheetDescription>
        </SheetHeader>

        <div className="px-6 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Refresh interval</span>
          <Select value={String(intervalSec)} onValueChange={(v) => setIntervalSec(Number(v))}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 15, 30, 45, 60].map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted-foreground">minimum 10s · default 30s</span>
          {loading && <Loader2 className="h-4 w-4 animate-spin ml-auto text-muted-foreground" />}
        </div>

        <ScrollArea className="flex-1 px-6 pb-6">
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <StatCard icon={Cpu} label="CPU usage" value={latest ? `${latest.cpuPct.toFixed(1)}%` : "—"} sub={`${vm?.vcpu ?? 0} vCPU`} color="text-emerald-600" />
              <StatCard icon={MemoryStick} label="Memory" value={latest && vm ? `${(latest.memUsedMiB / 1024).toFixed(1)} / ${fmtMiB(vm.memoryMiB)}` : "—"} sub={`${memPct.toFixed(1)}% used`} color="text-violet-600" />
              <StatCard icon={Network} label="Network RX" value={latest ? `${(latest.netRxKbps / 1024).toFixed(2)} MB/s` : "—"} sub={`TX ${(latest?.netTxKbps ?? 0).toFixed(0)} kbps`} color="text-sky-600" />
              <StatCard icon={HardDrive} label="Disk read" value={latest ? `${(latest.diskRdKbps / 1024).toFixed(2)} MB/s` : "—"} sub={`write ${(latest?.diskWrKbps ?? 0).toFixed(0)} kbps`} color="text-orange-600" />
            </div>

            <Separator />

            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-muted-foreground">CPU history</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{latest?.cpuPct.toFixed(1)}%</span>
                </div>
                <MiniArea data={history} dataKey="cpuPct" color="#10b981" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-muted-foreground">Memory</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{memPct.toFixed(1)}%</span>
                </div>
                <Progress value={memPct} className="h-2" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-muted-foreground">Network RX history</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{(latest?.netRxKbps ?? 0).toFixed(0)} kbps</span>
                </div>
                <MiniArea data={history} dataKey="netRxKbps" color="#0284c7" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-muted-foreground">Disk write history</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{(latest?.diskWrKbps ?? 0).toFixed(0)} kbps</span>
                </div>
                <MiniArea data={history} dataKey="diskWrKbps" color="#ea580c" />
              </div>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* VNC console dialog (mock)                                         */
/* ------------------------------------------------------------------ */

function VncDialog({ vm, host, open, onOpenChange }: { vm: VmStat | null; host: HostStat | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [lines, setLines] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!open) return;
    const boot = [
      "SeaBIOS (version 1.16.3-debian-1.16.3-2)",
      "Booting from Hard Disk...",
      "GRUB loading.",
      "Loading Linux 6.1.0-25-amd64 ...",
      "Loading initial ramdisk ...",
      "[    0.000000] Linux version 6.1.0-25-amd64 (debian)",
      "[    0.012345] bootmisc: initial ramdisk loaded",
      "[    1.213] systemd[1]: System Initialization",
      "[    2.451] Started Network Manager.",
      "[    2.980] Reached target Multi-User System.",
      "node01 login: _",
    ];
    let i = 0;
    setLines([]);
    const id = setInterval(() => {
      if (i >= boot.length) {
        clearInterval(id);
        return;
      }
      setLines((p) => [...p, boot[i]]);
      i++;
    }, 220);
    return () => clearInterval(id);
  }, [open, vm?.name]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 overflow-hidden gap-0">
        <DialogHeader className="px-4 py-3 border-b bg-zinc-900">
          <DialogTitle className="text-zinc-100 flex items-center gap-2 text-sm">
            <MonitorPlay className="h-4 w-4 text-emerald-400" />
            VNC console — {vm?.name} <span className="text-zinc-500 font-normal">· {host?.name}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            noVNC session tunnelled through a WebSocket-to-VNC proxy (websockify-equivalent) over qemu+ssh
          </DialogDescription>
        </DialogHeader>
        <div className="bg-black h-[60vh] flex flex-col">
          <div className="px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[11px] text-zinc-400 tabular-nums">qemu+ssh://{host?.name}/system · vnc port 5901 · encrypted WS</span>
          </div>
          <div className="flex-1 p-3 font-mono text-[12px] leading-relaxed text-emerald-300 overflow-auto">
            {lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {l.startsWith("[") ? <span className="text-zinc-400">{l}</span> : l}
              </div>
            ))}
            <span className="inline-block w-2 h-4 bg-emerald-400 animate-pulse align-middle" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Main dashboard view                                               */
/* ------------------------------------------------------------------ */

export function DashboardView() {
  const [hostId, setHostId] = React.useState(HOSTS[0].id);
  const [statsVm, setStatsVm] = React.useState<VmStat | null>(null);
  const [statsOpen, setStatsOpen] = React.useState(false);
  const [vncVm, setVncVm] = React.useState<VmStat | null>(null);
  const [vncOpen, setVncOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const host = HOSTS.find((h) => h.id === hostId)!;

  function act(vm: VmStat, action: string) {
    const key = `${vm.name}:${action}`;
    setBusy(key);
    toast.message(`${action} → ${vm.name}`, { description: `Dispatched to ${host.name} via libvirt` });
    setTimeout(() => setBusy(null), 700);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      {/* Host sidebar */}
      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Server className="h-4 w-4" /> Hosts
            <Badge variant="secondary" className="ml-auto text-[10px]">
              {HOSTS.filter((h) => h.reachable).length}/{HOSTS.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-2 pt-0">
          <div className="space-y-1">
            {HOSTS.map((h) => {
              const active = h.id === hostId;
              return (
                <button
                  key={h.id}
                  onClick={() => setHostId(h.id)}
                  className={`w-full text-left rounded-lg px-3 py-2 transition-colors border ${
                    active ? "bg-accent border-border" : "border-transparent hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${h.reachable ? "bg-emerald-500" : "bg-zinc-400"}`} />
                    <span className="font-medium text-sm">{h.name}</span>
                    <ChevronRight className={`h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform ${active ? "rotate-90" : ""}`} />
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground truncate">{h.uri}</div>
                  {h.reachable && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {h.cpus} vCPU · {h.memoryGiB} GiB · {h.vms.length} VMs
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* VM list */}
      <Card className="h-fit">
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <span>{host.name}</span>
              <Badge className={`text-[10px] ${host.reachable ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600" : "border-zinc-400/40 bg-zinc-400/10 text-zinc-500"}`}>
                {host.reachable ? "reachable" : "unreachable"}
              </Badge>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">{host.reachable ? host.hostname : "Could not open qemu+ssh connection"}</p>
          </div>
          <Button variant="outline" size="sm" className="h-7">
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {!host.reachable || host.vms.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              {host.reachable ? "No domains defined on this host." : "Connect libvirt to list domains."}
            </div>
          ) : (
            <div className="divide-y">
              <div className="grid grid-cols-[1fr_90px_70px_70px_auto] gap-2 px-4 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                <span>Name</span>
                <span>State</span>
                <span>vCPU</span>
                <span>Memory</span>
                <span className="text-right">Actions</span>
              </div>
              {host.vms.map((vm) => {
                const s = STATE_STYLES[vm.state];
                const isRunning = vm.state === "running";
                return (
                  <div key={vm.name} className="grid grid-cols-[1fr_90px_70px_70px_auto] gap-2 px-4 py-2.5 items-center text-sm">
                    <div className="font-medium truncate">{vm.name}</div>
                    <div>
                      <Badge variant="outline" className={`gap-1.5 ${s.cls}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                        {s.label}
                      </Badge>
                    </div>
                    <div className="tabular-nums">{vm.vcpu}</div>
                    <div className="tabular-nums">{fmtMiB(vm.memoryMiB)}</div>
                    <div className="flex items-center justify-end gap-1">
                      {isRunning ? (
                        <>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => act(vm, "soft-shutdown")} title="Soft shutdown (ACPI)">
                            <Power className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => act(vm, "soft-reboot")} title="Soft reboot (ACPI)">
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => act(vm, "power-off")} title="Hard power off">
                            <Power className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => act(vm, "hard-reset")} title="Hard reset">
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => { setStatsVm(vm); setStatsOpen(true); act(vm, "stats"); }} title="Stats">
                            <Activity className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => { setVncVm(vm); setVncOpen(true); }} title="VNC console">
                            <MonitorPlay className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={vm.state === "paused"} onClick={() => act(vm, "power-on")} title="Power on">
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                          {vm.state === "paused" && (
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => act(vm, "power-off")} title="Hard power off">
                              <Power className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => { setStatsVm(vm); setStatsOpen(true); act(vm, "stats"); }} title="Stats">
                            <Activity className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 opacity-50 cursor-not-allowed" disabled title="VM not running">
                            <MonitorPlay className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      {busy === `${vm.name}:${"stats"}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <VmStatsSheet vm={statsVm} host={host} open={statsOpen} onOpenChange={setStatsOpen} />
      <VncDialog vm={vncVm} host={host} open={vncOpen} onOpenChange={setVncOpen} />
    </div>
  );
}
