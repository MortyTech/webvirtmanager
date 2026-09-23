export type VmState = "running" | "blocked" | "paused" | "shutdown" | "stopped" | "crashed" | "suspended" | "no state" | "unknown";

export interface MeResponse {
  auth_enabled: boolean;
  username?: string;
  groups?: string[];
  detail?: string;
}

export interface HostStatus {
  host: string;
  uri?: string;
  reachable: boolean;
  hostname?: string;
  cpu_model?: string;
  cpus?: number;
  mhz?: number;
  memory_kib?: number;
  nodes?: number;
  sockets?: number;
  cores_per_socket?: number;
  threads_per_core?: number;
  total_vms?: number;
  active_vms?: number;
  error?: string;
}

export interface VmInfo {
  name: string;
  uuid: string;
  state_code: number;
  state: VmState;
  vcpu: number;
  max_memory_kib: number;
  memory_kib: number;
  cpu_time_ns: number;
  autostart: boolean;
  persistent: boolean;
}

export interface DiskStat {
  device: string;
  rd_req?: number;
  wr_req?: number;
  rd_bytes?: number;
  wr_bytes?: number;
  errs?: number;
  capacity_bytes?: number;
  allocation_bytes?: number;
}

export interface NetStat {
  device: string;
  rx_bytes: number;
  rx_packets: number;
  rx_errs: number;
  rx_drops: number;
  tx_bytes: number;
  tx_packets: number;
  tx_errs: number;
  tx_drops: number;
}

export interface VmStats {
  host: string;
  vm: string;
  state: VmState;
  vcpu: number;
  max_memory_kib: number;
  memory_kib: number;
  cpu_time_ns: number;
  memory_stats: Record<string, number>;
  disks: DiskStat[];
  net: NetStat[];
}

export interface VncSession {
  token: string;
  path: string;
  vnc_port: number;
}

export interface ActionResult {
  ok: boolean;
  state: VmState;
}
