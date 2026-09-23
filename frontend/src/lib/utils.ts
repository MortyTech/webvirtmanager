import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatKiB(kib: number): string {
  if (kib == null || (typeof kib === "number" && isNaN(kib))) return "—";
  const TIB = 1024 ** 3; // KiB in a TiB
  const GIB = 1024 ** 2; // KiB in a GiB
  const MIB = 1024; // KiB in a MiB
  if (kib >= TIB) return `${(kib / TIB).toFixed(1)} TiB`;
  if (kib >= GIB) return `${(kib / GIB).toFixed(kib % GIB === 0 ? 0 : 1)} GiB`;
  if (kib >= MIB) return `${Math.round(kib / MIB)} MiB`;
  return `${Math.round(kib)} KiB`;
}

export function formatBytes(b: number): string {
  if (b == null || (typeof b === "number" && isNaN(b))) return "—";
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TiB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KiB`;
  return `${Math.round(b)} B`;
}
