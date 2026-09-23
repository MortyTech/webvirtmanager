import { useEffect, useState } from "react";
import { MonitorPlay, RefreshCw, ShieldCheck, Server } from "lucide-react";
import { HostSidebar } from "@/components/HostSidebar";
import { VmTable } from "@/components/VmTable";
import { VmStatsSheet } from "@/components/VmStatsSheet";
import { VncConsole } from "@/components/VncConsole";
import { UserMenu } from "@/components/UserMenu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toaster, toast } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/misc";
import { api, redirectToLogin, ApiError } from "@/api";
import { usePolling } from "@/hooks/usePolling";
import type { HostStatus, MeResponse, VmInfo } from "@/types";

export default function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meLoading, setMeLoading] = useState(true);

  // Host list: polled on a slow cadence (separate from VM stats).
  const hostsPoll = usePolling<{ hosts: HostStatus[] }>(() => api.hosts(), 30, {
    enabled: !!me,
  });

  const [selectedHost, setSelectedHost] = useState<string>("");
  const [vmList, setVmList] = useState<VmInfo[]>([]);
  const [vmLoading, setVmLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [statsVm, setStatsVm] = useState<VmInfo | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [vncVm, setVncVm] = useState<VmInfo | null>(null);
  const [vncOpen, setVncOpen] = useState(false);

  // ---- bootstrap: /api/me --------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const m = await api.me();
        setMe(m);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          redirectToLogin();
          return;
        }
      } finally {
        setMeLoading(false);
      }
    })();
  }, []);

  // Keep a host selected as the list loads/changes.
  useEffect(() => {
    const h = hostsPoll.data?.hosts ?? [];
    if (h.length && (!selectedHost || !h.some((x) => x.host === selectedHost))) {
      setSelectedHost(h[0].host);
    }
  }, [hostsPoll.data, selectedHost]);

  // ---- VM list for selected host ------------------------------------------
  useEffect(() => {
    if (!selectedHost) {
      setVmList([]);
      return;
    }
    let cancelled = false;
    setVmLoading(true);
    (async () => {
      try {
        const r = await api.vms(selectedHost);
        if (!cancelled) setVmList(r.vms);
      } catch (e) {
        if (!cancelled) {
          setVmList([]);
          toast({ title: "Failed to load VMs", description: e instanceof Error ? e.message : String(e), variant: "error" });
        }
      } finally {
        if (!cancelled) setVmLoading(false);
      }
    })();
    const id = setInterval(async () => {
      try {
        const r = await api.vms(selectedHost);
        if (!cancelled) setVmList(r.vms);
      } catch {
        /* keep stale */
      }
    }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedHost]);

  // ---- actions ------------------------------------------------------------
  async function handleAction(vm: VmInfo, action: string) {
    if (!selectedHost) return;
    const key = `${vm.name}:*`;
    setBusyKey(key);
    toast({ title: `${action} → ${vm.name}`, description: `Dispatched to ${selectedHost} via libvirt` });
    try {
      await api.action(selectedHost, vm.name, action);
      // refresh VM list to reflect new state shortly after
      setTimeout(async () => {
        try {
          const r = await api.vms(selectedHost);
          setVmList(r.vms);
        } catch {
          /* ignore */
        }
      }, 800);
    } catch (e) {
      toast({ title: `Action failed`, description: e instanceof Error ? e.message : String(e), variant: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  function handleLogout() {
    // Backend /logout destroys the local session and 302s to the IdP end-session endpoint.
    window.location.href = "/logout";
  }

  // ---- render -------------------------------------------------------------
  const hosts = hostsPoll.data?.hosts ?? [];
  const selectedHostObj = hosts.find((h) => h.host === selectedHost) || null;

  if (meLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner className="h-6 w-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white">
              <MonitorPlay className="h-4.5 w-4.5" />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-sm">Webvirt</div>
              <div className="text-[11px] text-muted-foreground -mt-0.5">web virt-manager</div>
            </div>
          </div>

          {me?.auth_enabled ? (
            <Badge variant="secondary" className="hidden sm:inline-flex text-[10px] gap-1 ml-1">
              <ShieldCheck className="h-3 w-3" /> OIDC
            </Badge>
          ) : (
            <Badge variant="secondary" className="hidden sm:inline-flex text-[10px] gap-1 ml-1">
              <Server className="h-3 w-3" /> no-auth
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => hostsPoll.refresh()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh hosts
            </Button>
            {me?.auth_enabled && <UserMenu me={me} onLogout={handleLogout} />}
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 py-4">
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <HostSidebar
            hosts={hosts}
            selected={selectedHost}
            onSelect={setSelectedHost}
          />
          <VmTable
            host={selectedHostObj}
            vms={vmList}
            loading={vmLoading}
            onAction={handleAction}
            onStats={(vm) => {
              setStatsVm(vm);
              setStatsOpen(true);
            }}
            onConsole={(vm) => {
              setVncVm(vm);
              setVncOpen(true);
            }}
            busyKey={busyKey}
          />
        </div>
      </main>

      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-[12px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <MonitorPlay className="h-3.5 w-3.5 text-emerald-600" />
            <span>Webvirt — FastAPI · React · libvirt-python · noVNC</span>
          </div>
          <span>qemu+ssh · WS-to-VNC proxy · single INI config · no DB</span>
        </div>
      </footer>

      <VmStatsSheet host={selectedHost} vm={statsVm} open={statsOpen} onOpenChange={setStatsOpen} />
      <VncConsole host={selectedHost} vm={vncVm} open={vncOpen} onOpenChange={setVncOpen} />
      <Toaster />
    </div>
  );
}
