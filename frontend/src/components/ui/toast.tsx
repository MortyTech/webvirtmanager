import { useEffect, useState } from "react";

type Toast = { id: number; title: string; description?: string; variant?: "default" | "error" };
let _id = 0;
const listeners = new Set<(t: Toast) => void>();

export function toast(t: Omit<Toast, "id">) {
  const full: Toast = { id: ++_id, ...t };
  listeners.forEach((l) => l(full));
}

export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const fn = (t: Toast) => {
      setItems((prev) => [...prev, t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 3500);
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return items;
}

export function Toaster() {
  const items = useToasts();
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`min-w-[240px] max-w-sm rounded-lg border bg-background p-3 shadow-lg ${
            t.variant === "error" ? "border-destructive/40" : "border-border"
          }`}
        >
          <div className="text-sm font-medium">{t.title}</div>
          {t.description && (
            <div className="text-xs text-muted-foreground mt-0.5">{t.description}</div>
          )}
        </div>
      ))}
    </div>
  );
}
