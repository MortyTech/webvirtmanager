import type {
  ActionResult,
  HostStatus,
  MeResponse,
  VmInfo,
  VmStats,
  VncSession,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    credentials: "include",
  });
  if (res.status === 401) {
    // Not authenticated — let the app redirect to /login (which 302s to the IdP).
    throw new ApiError(401, "unauthenticated");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || JSON.stringify(j);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => req<MeResponse>("/api/me"),
  hosts: () => req<{ hosts: HostStatus[] }>("/api/hosts"),
  vms: (host: string) => req<{ host: string; vms: VmInfo[] }>(`/api/hosts/${encodeURIComponent(host)}/vms`),
  stats: (host: string, vm: string) =>
    req<VmStats>(`/api/hosts/${encodeURIComponent(host)}/vms/${encodeURIComponent(vm)}/stats`),
  action: (host: string, vm: string, action: string) =>
    req<ActionResult>(
      `/api/hosts/${encodeURIComponent(host)}/vms/${encodeURIComponent(vm)}/${action}`,
      { method: "POST" }
    ),
  openVnc: (host: string, vm: string) =>
    req<VncSession>(
      `/api/hosts/${encodeURIComponent(host)}/vms/${encodeURIComponent(vm)}/vnc`,
      { method: "POST" }
    ),
};

export function redirectToLogin() {
  // /login is a backend route that 302s to the IdP authorization endpoint.
  window.location.href = "/login";
}
