import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator, Progress, Spinner } from "@/components/ui/misc";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/api";
import type { VmInfo, VmStats } from "@/types";
import { formatBytes, formatKiB } from "@/lib/utils";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Sample {
  t: number;
  cpuPct: number;
  memPct: number;
  netRx: number; // bytes/s
  netTx: number;
  diskRd: number; // bytes/s
  diskWr: number;
}

export function VmStatsSheet({
  host,
  vm,
  open,
  onOpenChange,
}: {
  host: string;
  vm: VmInfo | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [intervalSec, setIntervalSec] = useState(30);
  const [history, setHistory] = useState<Sample[]>([]);
  const prevRef = useRef<{ stats: VmStats; t: number } | null>(null);

  const fetcher = useMemo(
    () => () => (vm ? api.stats(host, vm.name) : Promise.reject(new Error("no vm"))),
    [host, vm]
  );

  const { data, error, loading, refresh } = usePolling<VmStats>(fetcher, intervalSec, {
    enabled: open && !!vm,
  });

  // compute rates (deltas) between consecutive samples
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    let cpuPct = 0;
    let netRx = 0;
    let netTx = 0;
    let diskRd = 0;
    let diskWr = 0;
    const prev = prevRef.current;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) {
        const dCpu = data.cpu_time_ns - prev.stats.cpu_time_ns;
        cpuPct = Math.max(0, (dCpu / 1e9 / dt / Math.max(1, data.vcpu)) * 100);
        const prevNet = prev.stats.net.reduce((a, n) => a + n.rx_bytes, 0);
        const prevTx = prev.stats.net.reduce((a, n) => a + n.tx_bytes, 0);
        const curRx = data.net.reduce((a, n) => a + n.rx_bytes, 0);
        const curTx = data.net.reduce((a, n) => a + n.tx_bytes, 0);
        netRx = Math.max(0, (curRx - prevNet) / dt);
        netTx = Math.max(0, (curTx - prevTx) / dt);
        const prevRd = prev.stats.disks.reduce((a, d) => a + (d.rd_bytes || 0), 0);
        const prevWr = prev.stats.disks.reduce((a, d) => a + (d.wr_bytes || 0), 0);
        const curRd = data.disks.reduce((a, d) => a + (d.rd_bytes || 0), 0);
        const curWr = data.disks.reduce((a, d) => a + (d.wr_bytes || 0), 0);
        diskRd = Math.max(0, (curRd - prevRd) / dt);
        diskWr = Math.max(0, (curWr - prevWr) / dt);
      }
    }
    prevRef.current = { stats: data, t: now };
    const memPct = data.max_memory_kib
      ? (data.memory_kib / data.max_memory_kib) * 100
      : 0;
    setHistory((h) => [...h.slice(-29), { t: now, cpuPct, memPct, netRx, netTx, diskRd, diskWr }]);
  }, [data]);

  // reset history when switching VM
  useEffect(() => {
    prevRef.current = null;
    setHistory([]);
  }, [vm?.name]);

  const latest = history[history.length - 1];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-4 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-emerald-600" />
            {vm?.name ?? "VM"}
          </SheetTitle>
          <SheetDescription>
            Live statistics — {host} · polling controlled client-side · minimum 10s
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
          <span className="text-[11px] text-muted-foreground">default 30s</span>
          {loading && <Spinner className="ml-auto text-muted-foreground" />}
        </div>

        <div className="flex-1 overflow-auto px-6 pb-6">
          {error ? (
            <div className="text-sm text-destructive">Error: {error}</div>
          ) : !data ? (
            <div className="text-sm text-muted-foreground">Waiting for first sample…</div>
          ) : (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Stat icon={Cpu} label="CPU usage" value={`${latest ? latest.cpuPct.toFixed(1) : "—"}%`} sub={`${data.vcpu} vCPU`} color="text-emerald-600" />
                <Stat icon={MemoryStick} label="Memory" value={`${formatKiB(data.memory_kib)} / ${formatKiB(data.max_memory_kib)}`} sub={`${latest ? latest.memPct.toFixed(1) : "0"}% used`} color="text-violet-600" />
                <Stat icon={Network} label="Network RX" value={latest ? `${formatBytes(latest.netRx)}/s` : "—"} sub={`TX ${latest ? formatBytes(latest.netTx) + "/s" : "—"}`} color="text-sky-600" />
                <Stat icon={HardDrive} label="Disk read" value={latest ? `${formatBytes(latest.diskRd)}/s` : "—"} sub={`write ${latest ? formatBytes(latest.diskWr) + "/s" : "—"}`} color="text-orange-600" />
              </div>

              <Separator />

              <div className="space-y-4">
                <ChartBlock title="CPU history" value={`${latest ? latest.cpuPct.toFixed(1) : "0"}%`} data={history} dataKey="cpuPct" color="#10b981" fmt={(v) => `${Number(v).toFixed(1)}%`} />
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-muted-foreground">Memory</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {latest ? latest.memPct.toFixed(1) : "0"}%
                    </span>
                  </div>
                  <Progress value={latest ? latest.memPct : 0} className="h-2" />
                </div>
                <ChartBlock title="Network RX history" value={latest ? `${formatBytes(latest.netRx)}/s` : "—"} data={history} dataKey="netRx" color="#0284c7" fmt={(v) => formatBytes(Number(v)) + "/s"} />
                <ChartBlock title="Disk write history" value={latest ? `${formatBytes(latest.diskWr)}/s` : "—"} data={history} dataKey="diskWr" color="#ea580c" fmt={(v) => formatBytes(Number(v)) + "/s"} />
              </div>
            </div>
          )}
          <div className="mt-4 text-[11px] text-muted-foreground">
            <button onClick={refresh} className="underline">Refresh now</button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({
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

function ChartBlock({
  title,
  value,
  data,
  dataKey,
  color,
  fmt,
}: {
  title: string;
  value: string;
  data: Sample[];
  dataKey: keyof Sample;
  color: string;
  fmt: (v: number) => string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{value}</span>
      </div>
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
              formatter={(v: number) => [fmt(v), ""]}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
