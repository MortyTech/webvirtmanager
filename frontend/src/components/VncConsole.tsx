import { useEffect, useRef, useState } from "react";
import { Loader2, MonitorPlay, Lock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/api";
import type { VmInfo } from "@/types";
import type { RfbInstance } from "@novnc/novnc";

type Phase = "opening" | "connecting" | "connected" | "error" | "need-password";

export function VncConsole({
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
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbInstance | null>(null);
  const [phase, setPhase] = useState<Phase>("opening");
  const [errMsg, setErrMsg] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!open || !vm) return;
    let cancelled = false;
    setPhase("opening");
    setErrMsg("");

    (async () => {
      try {
        const session = await api.openVnc(host, vm.name);
        if (cancelled) return;
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}${session.path}`;
        setPhase("connecting");
        const RFB = (await import("@novnc/novnc")).default;
        if (cancelled) return;
        if (!containerRef.current) return;
        const rfb = new RFB(containerRef.current, url, {});
        rfbRef.current = rfb;
        rfb.scaleViewport = true;
        rfb.addEventListener("connect", () => {
          if (!cancelled) setPhase("connected");
        });
        rfb.addEventListener("disconnect", (ev: { detail?: { password?: boolean } }) => {
          if (cancelled) return;
          if (ev.detail?.password) {
            setPhase("need-password");
          } else {
            setPhase("error");
            setErrMsg("VNC session disconnected");
          }
        });
        rfb.addEventListener("credentialsrequired", () => {
          if (!cancelled) setPhase("need-password");
        });
      } catch (e) {
        if (cancelled) return;
        setPhase("error");
        setErrMsg(e instanceof ApiError ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      try {
        rfbRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      rfbRef.current = null;
    };
  }, [open, vm?.name, host]);

  function submitPassword() {
    if (rfbRef.current && password) {
      rfbRef.current.sendCredentials({ password });
      setPhase("connecting");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl p-0 overflow-hidden gap-0">
        <DialogHeader className="px-4 py-3 border-b bg-zinc-900">
          <DialogTitle className="text-zinc-100 flex items-center gap-2 text-sm">
            <MonitorPlay className="h-4 w-4 text-emerald-400" />
            VNC console — {vm?.name}
            <span className="text-zinc-500 font-normal">· {host}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            noVNC session tunnelled through a WebSocket-to-VNC proxy (websockify-equivalent) over qemu+ssh
          </DialogDescription>
        </DialogHeader>
        <div className="relative bg-black h-[70vh]">
          <div ref={containerRef} className="absolute inset-0" />
          {phase !== "connected" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-300">
              {phase === "opening" || phase === "connecting" ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
                  <span className="text-sm">
                    {phase === "opening"
                      ? "Requesting VNC session from backend…"
                      : "Opening WebSocket-to-VNC tunnel (qemu+ssh)…"}
                  </span>
                </>
              ) : phase === "need-password" ? (
                <div className="flex flex-col items-center gap-2">
                  <Lock className="h-5 w-5 text-amber-400" />
                  <div className="text-sm">VNC password required</div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      autoFocus
                      placeholder="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                      className="h-8 w-48 bg-zinc-900 border-zinc-700 text-zinc-100"
                    />
                    <Button size="sm" onClick={submitPassword}>Submit</Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-red-400 px-6 text-center">
                  {errMsg || "Failed to open VNC console"}
                  <div className="text-xs text-zinc-500 mt-2">
                    Make sure the VM is running, libvirt exposed a VNC device, and the SSH
                    tunnel to the host succeeded.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
