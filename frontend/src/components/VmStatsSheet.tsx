import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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

  // Compute per-second RATES from deltas of cumulative libvirt counters.
  // On the very first sample there's no previous point, so we DON'T push a
  // (zero) history point — that's what made the charts look like a linear
  // ramp from 0. The chart starts at the first real rate instead.
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const prev = prevRef.current;
    prevRef.current = { stats: data, t: now };
    if (!prev) return; // first sample: store baseline, no history point yet

    const dt = (now - prev.t) / 1000;
    if (dt <= 0) return;

    const dCpu = data.cpu_time_ns - prev.stats.cpu_time_ns;
    const cpuPct = Math.max(0, (dCpu / 1e9 / dt / Math.max(1, data.vcpu)) * 100);

    const prevRx = prev.stats.net.reduce((a, n) => a + n.rx_bytes, 0);
    const prevTx = prev.stats.net.reduce((a, n) => a + n.tx_bytes, 0);
    const curRx = data.net.reduce((a, n) => a + n.rx_bytes, 0);
    const curTx = data.net.reduce((a, n) => a + n.tx_bytes, 0);
    const netRx = Math.max(0, (curRx - prevRx) / dt);
    const netTx = Math.max(0, (curTx - prevTx) / dt);

    const prevRd = prev.stats.disks.reduce((a, d) => a + (d.rd_bytes || 0), 0);
    const prevWr = prev.stats.disks.reduce((a, d) => a + (d.wr_bytes || 0), 0);
    const curRd = data.disks.reduce((a, d) => a + (d.rd_bytes || 0), 0);
    const curWr = data.disks.reduce((a, d) => a + (d.wr_bytes || 0), 0);
    const diskRd = Math.max(0, (curRd - prevRd) / dt);
    const diskWr = Math.max(0, (curWr - prevWr) / dt);

    // Memory "used": prefer RSS (resident set) from memoryStats; fall back to
    // balloon actual-minus-unused, then to dom.info()'s current memory.
    const ms = data.memory_stats || {};
    let usedKib = data.memory_kib;
    if (ms.rss) usedKib = ms.rss;
    else if (ms.actual != null && ms.unused != null) usedKib = Math.max(0, ms.actual - ms.unused);
    const memPct = data.max_memory_kib ? (usedKib / data.max_memory_kib) * 100 : 0;

    setHistory((h) => [...h.slice(-39), { t: now, cpuPct, memPct, netRx, netTx, diskRd, diskWr }]);
  }, [data]);

  // Reset history when switching VM
  useEffect(() => {
    prevRef.current = null;
    setHistory([]);
  }, [vm?.name]);

  const latest = history[history.length - 1];
  const ms = data?.memory_stats || {};
  let usedKib = data?.memory_kib ?? 0;
  if (ms.rss) usedKib = ms.rss;
  else if (ms.actual != null && ms.unused != null) usedKib = Math.max(0, ms.actual - ms.unused);
  const memPct = data?.max_memory_kib ? (usedKib / data.max_memory_kib) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl w-[96vw] h-[90vh] p-0 overflow-hidden gap-0 flex flex-col">
        <DialogHeader className="px-5 py-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5 text-emerald-600" />
            {vm?.name}
            <span className="text-muted-foreground font-normal text-sm">· {host}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Live statistics — polling controlled client-side, minimum 10s
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-3 border-b shrink-0 flex items-center gap-3 flex-wrap">
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
          <button onClick={refresh} className="ml-auto text-xs text-emerald-600 hover:underline">
            Refresh now
          </button>
          {loading && <Spinner className="text-muted-foreground" />}
        </div>

        <div className="flex-1 overflow-auto p-5">
          {error ? (
            <div className="text-sm text-destructive">Error: {error}</div>
          ) : !data ? (
            <div className="text-sm text-muted-foreground py-10 text-center">
              Waiting for first sample from libvirt…
            </div>
          ) : (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat
                  icon={Cpu}
                  label="CPU usage"
                  value={latest ? `${latest.cpuPct.toFixed(1)}%` : "—"}
                  sub={`${data.vcpu} vCPU`}
                  color="text-emerald-600"
                />
                <Stat
                  icon={MemoryStick}
                  label="Memory (used / max)"
                  value={`${formatKiB(usedKib)} / ${formatKiB(data.max_memory_kib)}`}
                  sub={`${memPct.toFixed(1)}% of max`}
                  color="text-violet-600"
                />
                <Stat
                  icon={Network}
                  label="Network RX"
                  value={latest ? `${formatBytes(latest.netRx)}/s` : "—"}
                  sub={`TX ${latest ? formatBytes(latest.netTx) + "/s" : "—"}`}
                  color="text-sky-600"
                />
                <Stat
                  icon={HardDrive}
                  label="Disk read"
                  value={latest ? `${formatBytes(latest.diskRd)}/s` : "—"}
                  sub={`write ${latest ? formatBytes(latest.diskWr) + "/s" : "—"}`}
                  color="text-orange-600"
                />
              </div>

              <Separator />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ChartBlock
                  title="CPU usage history"
                  value={latest ? `${latest.cpuPct.toFixed(1)}%` : "—"}
                  data={history}
                  dataKey="cpuPct"
                  color="#10b981"
                  fmt={(v) => `${Number(v).toFixed(1)}%`}
                  height={160}
                />
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Memory (used / max)</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">{memPct.toFixed(1)}%</span>
                  </div>
                  <Progress value={memPct} className="h-3" />
                  <div className="text-[11px] text-muted-foreground">
                    {formatKiB(usedKib)} used of {formatKiB(data.max_memory_kib)} allocated
                  </div>
                </div>
                <ChartBlock
                  title="Network RX history"
                  value={latest ? `${formatBytes(latest.netRx)}/s` : "—"}
                  data={history}
                  dataKey="netRx"
                  color="#0284c7"
                  fmt={(v) => `${formatBytes(Number(v))}/s`}
                  height={160}
                />
                <ChartBlock
                  title="Disk write history"
                  value={latest ? `${formatBytes(latest.diskWr)}/s` : "—"}
                  data={history}
                  dataKey="diskWr"
                  color="#ea580c"
                  fmt={(v) => `${formatBytes(Number(v))}/s`}
                  height={160}
                />
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
        <div className="text-xl font-semibold tabular-nums">{value}</div>
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
  height,
}: {
  title: string;
  value: string;
  data: Sample[];
  dataKey: keyof Sample;
  color: string;
  fmt: (v: number) => string;
  height: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{value}</span>
      </div>
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`g-${String(dataKey)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.5} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#g-${String(dataKey)})`}
              isAnimationActive={false}
            />
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
