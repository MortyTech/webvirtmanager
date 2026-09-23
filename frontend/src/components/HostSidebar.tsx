import { ChevronRight, Server } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { HostStatus } from "@/types";
import { cn } from "@/lib/utils";

export function HostSidebar({
  hosts,
  selected,
  onSelect,
}: {
  hosts: HostStatus[];
  selected: string;
  onSelect: (host: string) => void;
}) {
  const reachable = hosts.filter((h) => h.reachable).length;
  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Server className="h-4 w-4" /> Hosts
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {reachable}/{hosts.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        <div className="space-y-1">
          {hosts.map((h) => {
            const active = h.host === selected;
            return (
              <button
                key={h.host}
                onClick={() => onSelect(h.host)}
                className={cn(
                  "w-full text-left rounded-lg px-3 py-2 transition-colors border",
                  active ? "bg-accent border-border" : "border-transparent hover:bg-accent/50"
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      h.reachable ? "bg-emerald-500" : "bg-zinc-400"
                    )}
                  />
                  <span className="font-medium text-sm">{h.host}</span>
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform",
                      active && "rotate-90"
                    )}
                  />
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground truncate">{h.uri}</div>
                {h.reachable ? (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {h.cpus} vCPU · {h.memory_kib ? Math.round(h.memory_kib / 1024 / 1024) : "?"} GiB ·{" "}
                    {h.total_vms ?? 0} VMs
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] text-muted-foreground truncate">
                    {h.error || "unreachable"}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
