import { useMemo, useState } from "react";
import {
  Activity,
  ChevronUp,
  FileCode,
  MonitorPlay,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import type { HostStatus, VmInfo } from "@/types";
import { cn, formatKiB } from "@/lib/utils";

const STATE_STYLES: Record<string, string> = {
  running: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  blocked: "border-zinc-400/40 bg-zinc-400/10 text-zinc-500",
  paused: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  shutdown: "border-zinc-400/40 bg-zinc-400/10 text-zinc-500",
  stopped: "border-zinc-400/40 bg-zinc-400/10 text-zinc-500",
  crashed: "border-red-500/40 bg-red-500/10 text-red-600",
  suspended: "border-amber-500/40 bg-amber-500/10 text-amber-600",
};

// Power-state sort priority (running first, dead last).
const STATE_ORDER: Record<string, number> = {
  running: 0,
  paused: 1,
  suspended: 2,
  blocked: 3,
  shutdown: 4,
  stopped: 5,
  crashed: 6,
};

type SortKey = "name" | "state";

export function VmTable({
  host,
  vms,
  loading,
  onAction,
  onStats,
  onConsole,
  onEditXml,
  busyKey,
}: {
  host: HostStatus | null;
  vms: VmInfo[];
  loading: boolean;
  onAction: (vm: VmInfo, action: string) => void;
  onStats: (vm: VmInfo) => void;
  onConsole: (vm: VmInfo) => void;
  onEditXml: (vm: VmInfo) => void;
  busyKey: string | null;
}) {
  const reachable = host?.reachable;
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = [...vms];
    arr.sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
      const so = (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99);
      return so * dir || a.name.localeCompare(b.name);
    });
    return arr;
  }, [vms, sortKey, sortDir]);

  const SortIcon = ({ active }: { active: boolean }) =>
    active ? (
      <ChevronUp
        className={cn("h-3 w-3 transition-transform", sortDir === "desc" && "rotate-180")}
      />
    ) : (
      <ChevronUp className="h-3 w-3 opacity-25" />
    );

  return (
    <Card className="h-fit">
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm flex items-center gap-2">
            <span>{host?.host ?? "—"}</span>
            <Badge
              className={cn(
                "text-[10px]",
                reachable
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                  : "border-zinc-400/40 bg-zinc-400/10 text-zinc-500"
              )}
            >
              {reachable ? "reachable" : "unreachable"}
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {reachable ? host?.hostname : host?.error || "Could not open qemu+ssh connection"}
          </p>
        </div>
        {loading && <Spinner className="text-muted-foreground" />}
      </CardHeader>
      <CardContent className="p-0">
        {!reachable || sorted.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            {reachable
              ? "No domains defined on this host."
              : "Connect libvirt (qemu+ssh) to list domains."}
          </div>
        ) : (
          // A real <table> guarantees consistent column widths across ALL rows
          // (header + data) — table-layout:auto sizes each column to its
          // widest cell, so STATE sits right beside the longest name AND every
          // row's columns line up vertically.
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  <th className="text-left font-medium px-4 py-2 align-middle">
                    <button
                      onClick={() => toggleSort("name")}
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      Name <SortIcon active={sortKey === "name"} />
                    </button>
                  </th>
                  <th className="text-left font-medium px-2 py-2 align-middle">
                    <button
                      onClick={() => toggleSort("state")}
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      State <SortIcon active={sortKey === "state"} />
                    </button>
                  </th>
                  <th className="text-right font-medium px-2 py-2 align-middle">vCPU</th>
                  <th className="text-right font-medium px-2 py-2 align-middle">Memory</th>
                  <th className="text-right font-medium px-4 py-2 align-middle">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((vm) => {
                  const isRunning = vm.state === "running";
                  const isBusy = busyKey === `${vm.name}:*`;
                  return (
                    <tr key={vm.uuid || vm.name} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 align-middle">
                        <div className="font-medium truncate max-w-[260px]">{vm.name}</div>
                      </td>
                      <td className="px-2 py-2.5 align-middle">
                        <Badge
                          variant="outline"
                          className={cn(
                            "w-20 justify-center whitespace-nowrap gap-1.5",
                            STATE_STYLES[vm.state]
                          )}
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              vm.state === "running" && "bg-emerald-500",
                              vm.state === "paused" && "bg-amber-500",
                              (vm.state === "stopped" || vm.state === "shutdown") && "bg-zinc-400"
                            )}
                          />
                          {vm.state}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 align-middle text-right tabular-nums">{vm.vcpu}</td>
                      <td className="px-2 py-2.5 align-middle text-right tabular-nums">
                        {formatKiB(vm.max_memory_kib)}
                      </td>
                      <td className="px-4 py-2.5 align-middle">
                        <div className="flex items-center justify-end gap-1">
                          {isRunning ? (
                            <>
                              <Button size="xs" variant="ghost" onClick={() => onAction(vm, "soft-shutdown")} title="Soft shutdown (ACPI)">
                                <Power className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="xs" variant="ghost" onClick={() => onAction(vm, "soft-reboot")} title="Soft reboot (ACPI)">
                                <RefreshCw className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="xs" variant="ghost" className="text-destructive" onClick={() => onAction(vm, "power-off")} title="Stop (force power off)">
                                <Square className="h-3.5 w-3.5 fill-current" />
                              </Button>
                              <Button size="xs" variant="ghost" className="text-destructive" onClick={() => onAction(vm, "hard-reset")} title="Hard reset">
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="xs" variant="outline" onClick={() => onStats(vm)} title="Stats">
                                <Activity className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="xs" variant="outline" onClick={() => onConsole(vm)} title="VNC console">
                                <MonitorPlay className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="xs" variant="outline" onClick={() => onEditXml(vm)} title="Edit XML (virsh edit)">
                                <FileCode className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button size="xs" variant="ghost" disabled={vm.state === "paused"} onClick={() => onAction(vm, "power-on")} title="Power on">
                                <Play className="h-3.5 w-3.5" />
                              </Button>
                              {vm.state === "paused" && (
                                <Button size="xs" variant="ghost" className="text-destructive" onClick={() => onAction(vm, "power-off")} title="Stop (force power off)">
                                  <Square className="h-3.5 w-3.5 fill-current" />
                                </Button>
                              )}
                              <Button size="xs" variant="outline" onClick={() => onStats(vm)} title="Stats">
                                <Activity className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="xs" variant="outline" disabled title="VM not running">
                                <MonitorPlay className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="xs" variant="outline" onClick={() => onEditXml(vm)} title="Edit XML (virsh edit)">
                                <FileCode className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                          {isBusy && <Spinner className="text-muted-foreground" />}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
