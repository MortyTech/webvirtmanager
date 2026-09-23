import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { xml as xmlLang } from "@codemirror/lang-xml";
import { FileCode, Loader2, Save, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { api, ApiError } from "@/api";
import type { VmInfo } from "@/types";
import { toast } from "@/components/ui/toast";

export function XmlEditor({
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
  const [xml, setXml] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the domain XML when the editor opens (or the VM changes).
  useEffect(() => {
    if (!open || !vm) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setXml("");
    (async () => {
      try {
        const r = await api.getXml(host, vm.name);
        if (cancelled) return;
        setXml(r.xml);
        setOriginal(r.xml);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, vm?.name, host]);

  const dirty = xml !== original;

  function isWellFormedXml(s: string): { ok: boolean; err?: string } {
    try {
      // DOMParser is available in browsers; throws on parse error via the doc.
      const doc = new DOMParser().parseFromString(s, "application/xml");
      const perr = doc.querySelector("parsererror");
      if (perr) {
        return { ok: false, err: "XML is not well-formed: " + perr.textContent?.slice(0, 300) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, err: "XML parse error: " + (e instanceof Error ? e.message : String(e)) };
    }
  }

  async function handleSave() {
    if (!vm) return;
    setError(null);
    // 1) client-side well-formedness check — never send broken XML to libvirt.
    const check = isWellFormedXml(xml);
    if (!check.ok) {
      setError(check.err || "Invalid XML");
      return;
    }
    setSaving(true);
    try {
      await api.saveXml(host, vm.name, xml);
      setOriginal(xml); // mark clean
      toast({ title: "XML saved", description: `${vm.name} definition updated (virDomainDefineXML)` });
      onOpenChange(false);
    } catch (e) {
      // libvirt rejection (or server parse error) — keep editor open, show why.
      const msg = e instanceof ApiError ? e.message : String(e);
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl w-[96vw] h-[88vh] p-0 overflow-hidden gap-0 flex flex-col">
        <DialogHeader className="px-4 py-2.5 border-b bg-zinc-900 shrink-0 flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-zinc-100 flex items-center gap-2 text-sm">
            <FileCode className="h-4 w-4 text-emerald-400" />
            Edit XML — {vm?.name}
            <span className="text-zinc-500 font-normal">· {host}</span>
            {dirty && (
              <span className="text-amber-400 text-[11px] font-normal">· unsaved</span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            virsh edit equivalent: edit the libvirt domain XML. Save is rejected if the XML is
            malformed or libvirt rejects it; the editor keeps your changes.
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar */}
        <div className="px-3 py-1.5 border-b bg-zinc-900/60 flex items-center gap-2 shrink-0">
          <Button size="xs" variant="secondary" onClick={handleSave} disabled={saving || loading || !dirty} className="bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-100">
            <Save className="h-3.5 w-3.5" /> Save
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onOpenChange(false)} className="text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800">
            <X className="h-3.5 w-3.5" /> Close
          </Button>
          {saving && <Spinner className="text-muted-foreground" />}
          <span className="ml-auto text-[11px] text-zinc-500">
            virDomainDefineXML · changes apply to the persistent config (live on next boot)
          </span>
        </div>

        {/* Error banner (kept open with user's text intact) */}
        {error && (
          <div className="px-4 py-2 border-b bg-red-950/60 text-red-300 text-xs font-mono whitespace-pre-wrap break-all max-h-32 overflow-auto shrink-0">
            {error}
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 overflow-hidden bg-[#282a36] text-zinc-100">
          {loading ? (
            <div className="flex items-center justify-center h-full text-zinc-400 gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading domain XML…
            </div>
          ) : (
            <CodeMirror
              value={xml}
              height="100%"
              theme="dark"
              extensions={[xmlLang()]}
              onChange={(val) => setXml(val)}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLine: true,
                foldGutter: true,
                autocompletion: false,
              }}
              style={{ height: "100%", fontSize: "13px" }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
