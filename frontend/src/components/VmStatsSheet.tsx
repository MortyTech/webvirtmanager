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
import { Separator, Spinner } from "@/components/ui/misc";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/api";
import type { VmInfo, VmStats } from "@/types";
import { formatBytes, formatBitsPerSec, formatIops, formatKiB } from "@/lib/utils";

// Per-interval RATES (deltas of libvirt's cumulative counters over dt).
interface DiskRate {
  device: string;
  rdIops: number;
  wrIops: number;
  rdBytes: number; // bytes/s
  wrBytes: number; // bytes/s
}
interface Sample {
  cpuPct: number;
  netRx: number; // bytes/s
  netTx: number; // bytes/s
  perDisk: DiskRate[];
  agg: { rdIops: number; wrIops: number; rdBytes: number; wrBytes: number };
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
  const [latest, setLatest] = useState<Sample | null>(null);
  const prevRef = useRef<{ stats: VmStats; t: number } | null>(null);

  const fetcher = useMemo(
    () => () => (vm ? api.stats(host, vm.name) : Promise.reject(new Error("no vm"))),
    [host, vm]
  );

  const { data, error, loading, refresh } = usePolling<VmStats>(fetcher, intervalSec, {
    enabled: open && !!vm,
  });

  // Compute per-interval rates as deltas of cumulative counters (T1 -> T2).
  // On the first sample we just store the baseline; rates appear from the 2nd.
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const prev = prevRef.current;
    prevRef.current = { stats: data, t: now };
    if (!prev) return;

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

    // Per-disk rates, matched by device name; aggregated totals sum them.
    const prevDiskMap = new Map(prev.stats.disks.map((d) => [d.device, d]));
    const perDisk: DiskRate[] = [];
    const agg = { rdIops: 0, wrIops: 0, rdBytes: 0, wrBytes: 0 };
    for (const d of data.disks) {
      const p = prevDiskMap.get(d.device);
      if (!p) continue;
      const rate: DiskRate = {
        device: d.device,
        rdIops: Math.max(0, ((d.rd_req || 0) - (p.rd_req || 0)) / dt),
        wrIops: Math.max(0, ((d.wr_req || 0) - (p.wr_req || 0)) / dt),
        rdBytes: Math.max(0, ((d.rd_bytes || 0) - (p.rd_bytes || 0)) / dt),
        wrBytes: Math.max(0, ((d.wr_bytes || 0) - (p.wr_bytes || 0)) / dt),
      };
      perDisk.push(rate);
      agg.rdIops += rate.rdIops;
      agg.wrIops += rate.wrIops;
      agg.rdBytes += rate.rdBytes;
      agg.wrBytes += rate.wrBytes;
    }

    setLatest({ cpuPct, netRx, netTx, perDisk, agg });
  }, [data]);

  // Reset when switching VM
  useEffect(() => {
    prevRef.current = null;
    setLatest(null);
  }, [vm?.name]);

  // Memory "used": prefer RSS (resident), fall back to balloon actual-unused,
  // then dom.info()'s current memory.
  const ms = data?.memory_stats || {};
  let usedKib = data?.memory_kib ?? 0;
  if (ms.rss) usedKib = ms.rss;
  else if (ms.actual != null && ms.unused != null) usedKib = Math.max(0, ms.actual - ms.unused);
  const memPct = data?.max_memory_kib ? (usedKib / data.max_memory_kib) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl w-[96vw] h-auto max-h-[90vh] p-0 overflow-hidden gap-0 flex flex-col">
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
          <span className="text-[11px] text-muted-foreground">
            minimum 10s · default 30s · rates are per-interval deltas
          </span>
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
              {/* CPU + Memory */}
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
                {/* Network RX & TX — equal-weight cards, in BITS/s */}
                <Stat
                  icon={Network}
                  label="Network RX"
                  value={latest ? formatBitsPerSec(latest.netRx) : "—"}
                  sub="receive"
                  color="text-sky-600"
                />
                <Stat
                  icon={Network}
                  label="Network TX"
                  value={latest ? formatBitsPerSec(latest.netTx) : "—"}
                  sub="transmit"
                  color="text-sky-600"
                />
              </div>

              {/* Disk I/O — 4 metrics (IOPS read/write, throughput read/write) */}
              <div>
                <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Disk I/O{latest && latest.perDisk.length > 1 ? ` · aggregated (${latest.perDisk.length} disks)` : ""}
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Stat
                    icon={HardDrive}
                    label="Read IOPS"
                    value={latest ? formatIops(latest.agg.rdIops) : "—"}
                    sub="requests/s"
                    color="text-orange-600"
                  />
                  <Stat
                    icon={HardDrive}
                    label="Write IOPS"
                    value={latest ? formatIops(latest.agg.wrIops) : "—"}
                    sub="requests/s"
                    color="text-orange-600"
                  />
                  <Stat
                    icon={HardDrive}
                    label="Read throughput"
                    value={latest ? `${formatBytes(latest.agg.rdBytes)}/s` : "—"}
                    sub="bytes/s"
                    color="text-orange-600"
                  />
                  <Stat
                    icon={HardDrive}
                    label="Write throughput"
                    value={latest ? `${formatBytes(latest.agg.wrBytes)}/s` : "—"}
                    sub="bytes/s"
                    color="text-orange-600"
                  />
                </div>

                {/* Per-disk breakdown (only when >1 disk) */}
                {latest && latest.perDisk.length > 1 && (
                  <details className="mt-3 group">
                    <summary className="text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground list-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform">▸</span>
                          Per-disk breakdown
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="border-b border-border text-muted-foreground">
                            <th className="text-left font-medium px-2 py-1.5">Device</th>
                            <th className="text-right font-medium px-2 py-1.5">Read IOPS</th>
                            <th className="text-right font-medium px-2 py-1.5">Write IOPS</th>
                            <th className="text-right font-medium px-2 py-1.5">Read</th>
                            <th className="text-right font-medium px-2 py-1.5">Write</th>
                          </tr>
                        </thead>
                        <tbody>
                          {latest.perDisk.map((d) => (
                            <tr key={d.device} className="border-b border-border last:border-0">
                              <td className="px-2 py-1.5 font-mono">{d.device}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{formatIops(d.rdIops)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{formatIops(d.wrIops)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{formatBytes(d.rdBytes)}/s</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{formatBytes(d.wrBytes)}/s</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </div>

              <Separator />

              <div className="text-[11px] text-muted-foreground">
                Rates computed as <code className="font-mono">(counter_T2 − counter_T1) / interval</code> from libvirt
                cumulative counters (dom.info / memoryStats / blockStats / interfaceStats).
                {!latest && " First sample establishes the baseline — values appear after the next poll."}
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
