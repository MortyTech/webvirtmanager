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

// Network throughput is traditionally measured in BITS per second (SI units:
// 1000-based), not bytes. Convert bytes/s -> bits/s (x8) and format.
export function formatBitsPerSec(bytesPerSec: number): string {
  if (bytesPerSec == null || (typeof bytesPerSec === "number" && isNaN(bytesPerSec)))
    return "—";
  const bps = bytesPerSec * 8;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(bps)} bps`;
}

// IOPS (operations per second) — compact with k suffix.
export function formatIops(iops: number): string {
  if (iops == null || (typeof iops === "number" && isNaN(iops))) return "—";
  if (iops >= 1000) return `${(iops / 1000).toFixed(1)}k IOPS`;
  return `${Math.round(iops)} IOPS`;
}
