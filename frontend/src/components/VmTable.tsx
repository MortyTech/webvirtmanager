import { useMemo } from "react";
import {
  Activity,
  MonitorPlay,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
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

export function VmTable({
  host,
  vms,
  loading,
  onAction,
  onStats,
  onConsole,
  busyKey,
}: {
  host: HostStatus | null;
  vms: VmInfo[];
  loading: boolean;
  onAction: (vm: VmInfo, action: string) => void;
  onStats: (vm: VmInfo) => void;
  onConsole: (vm: VmInfo) => void;
  busyKey: string | null;
}) {
  const reachable = host?.reachable;
  const sorted = useMemo(() => [...vms].sort((a, b) => a.name.localeCompare(b.name)), [vms]);

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
          <div className="divide-y">
            <div className="grid grid-cols-[1fr_100px_56px_88px_auto] gap-2 px-4 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              <span>Name</span>
              <span>State</span>
              <span className="text-right">vCPU</span>
              <span className="text-right">Memory</span>
              <span className="text-right">Actions</span>
            </div>
            {sorted.map((vm) => {
              const isRunning = vm.state === "running";
              const isBusy = busyKey === `${vm.name}:*`;
              return (
                <div
                  key={vm.uuid || vm.name}
                  className="grid grid-cols-[1fr_100px_56px_88px_auto] gap-2 px-4 py-2.5 items-center text-sm"
                >
                  <div className="font-medium truncate min-w-0">{vm.name}</div>
                  <div className="flex justify-start">
                    <Badge variant="outline" className={cn("w-20 justify-center whitespace-nowrap gap-1.5", STATE_STYLES[vm.state])}>
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
                  </div>
                  <div className="tabular-nums text-right">{vm.vcpu}</div>
                  <div className="tabular-nums text-right">{formatKiB(vm.max_memory_kib)}</div>
                  <div className="flex items-center justify-end gap-1">
                    {isRunning ? (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => onAction(vm, "soft-shutdown")} title="Soft shutdown (ACPI)">
                          <Power className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => onAction(vm, "soft-reboot")} title="Soft reboot (ACPI)">
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="xs" variant="ghost" className="text-destructive" onClick={() => onAction(vm, "power-off")} title="Hard power off">
                          <Power className="h-3.5 w-3.5" />
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
                      </>
                    ) : (
                      <>
                        <Button size="xs" variant="ghost" disabled={vm.state === "paused"} onClick={() => onAction(vm, "power-on")} title="Power on">
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                        {vm.state === "paused" && (
                          <Button size="xs" variant="ghost" className="text-destructive" onClick={() => onAction(vm, "power-off")} title="Hard power off">
                            <Power className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button size="xs" variant="outline" onClick={() => onStats(vm)} title="Stats">
                          <Activity className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="xs" variant="outline" disabled title="VM not running">
                          <MonitorPlay className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                    {isBusy && <Spinner className="text-muted-foreground" />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
