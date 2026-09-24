import { useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { xml as xmlLang } from "@codemirror/lang-xml";
import { FileUp, Plus, Upload, X } from "lucide-react";
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
import { toast } from "@/components/ui/toast";

const PLACEHOLDER = `<domain type='kvm'>
  <name>newvm</name>
  <memory unit='GiB'>2</memory>
  <vcpu>2</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <boot dev='hd'/>
  </os>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/var/lib/libvirt/images/newvm.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='network'>
      <source network='default'/>
      <model type='virtio'/>
    </interface>
    <graphics type='vnc' port='-1' autoport='yes' listen='0.0.0.0'/>
  </devices>
</domain>`;

export function DefineVmDialog({
  host,
  open,
  onOpenChange,
  onDefined,
}: {
  host: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDefined?: () => void;
}) {
  const [xml, setXml] = useState("");
  const [defining, setDefining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setXml("");
    setError(null);
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  function loadFile(file: File) {
    setError(null);
    if (!file) return;
    if (!/(\.xml|application\/xml|text\/xml)/i.test(file.name) && !file.type.includes("xml")) {
      // not a hard block, just a hint
    }
    const reader = new FileReader();
    reader.onload = () => {
      setXml(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => setError(`Failed to read file: ${reader.error?.message ?? "unknown"}`);
    reader.readAsText(file);
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
    // allow re-picking the same file
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  }

  function isWellFormedXml(s: string): { ok: boolean; err?: string } {
    try {
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

  async function handleDefine() {
    if (!host) return;
    setError(null);
    if (!xml.trim()) {
      setError("XML is empty — paste a <domain> definition or upload a file.");
      return;
    }
    // 1) client-side well-formedness check before sending to libvirt.
    const check = isWellFormedXml(xml);
    if (!check.ok) {
      setError(check.err || "Invalid XML");
      return;
    }
    setDefining(true);
    try {
      const r = await api.defineXml(host, xml);
      const name = r.name || "(unnamed)";
      toast({
        title: `VM '${name}' defined successfully on host '${host}'`,
        description: r.uuid ? `uuid: ${r.uuid}` : "virDomainDefineXML ok",
      });
      onDefined?.(); // refresh the VM list
      handleOpenChange(false); // close (and reset)
    } catch (e) {
      // libvirt rejection or server parse error — keep editor open with the text.
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setDefining(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-5xl w-[96vw] h-[88vh] p-0 overflow-hidden gap-0 flex flex-col">
        <DialogHeader className="px-4 py-2.5 border-b bg-zinc-900 shrink-0 flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-zinc-100 flex items-center gap-2 text-sm">
            <Plus className="h-4 w-4 text-emerald-400" />
            Define VM from XML
            <span className="text-zinc-500 font-normal">· {host}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            virsh define equivalent: paste or upload a &lt;domain&gt; XML document. Define is rejected if
            the XML is malformed or libvirt rejects it; the dialog keeps your text.
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar */}
        <div className="px-3 py-1.5 border-b bg-zinc-900/60 flex items-center gap-2 shrink-0 flex-wrap">
          <Button
            size="xs"
            variant="secondary"
            onClick={handleDefine}
            disabled={defining || !xml.trim()}
            className="bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-100"
          >
            <FileUp className="h-3.5 w-3.5" /> Define
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,application/xml,text/xml"
            onChange={handleFilePick}
            className="hidden"
          />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            className="text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800"
          >
            <Upload className="h-3.5 w-3.5" /> Upload file
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setXml(PLACEHOLDER)}
            className="text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800"
            title="Insert a minimal <domain> template"
          >
            Template
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            className="text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 ml-auto"
          >
            <X className="h-3.5 w-3.5" /> Close
          </Button>
          {defining && <Spinner className="text-muted-foreground" />}
        </div>

        {/* Error banner (kept open with user's text intact) */}
        {error && (
          <div className="px-4 py-2 border-b bg-red-950/60 text-red-300 text-xs font-mono whitespace-pre-wrap break-all max-h-32 overflow-auto shrink-0">
            {error}
          </div>
        )}

        {/* Editor with drag-and-drop file upload */}
        <div
          className="flex-1 overflow-hidden relative bg-[#282a36] text-zinc-100"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div className="absolute inset-0 z-10 bg-emerald-500/10 border-2 border-dashed border-emerald-400 flex items-center justify-center text-emerald-300 text-sm pointer-events-none">
              Drop XML file to load…
            </div>
          )}
          <CodeMirror
            value={xml}
            placeholder="Paste a <domain> XML document here, or drop / upload a .xml file…"
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
