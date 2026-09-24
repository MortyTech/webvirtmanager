"""
libvirt integration.

libvirt is imported lazily so the app can boot (and OIDC/config logic can run)
even when the system libvirt libraries are not installed — the Docker image
provides them. Calls are synchronous and run in Starlette's threadpool.

Connections are pooled per host with a per-host lock (serializes libvirt calls,
which is the safe way to share a libvirt connection across threads).
"""
from __future__ import annotations

import threading
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

try:
    import libvirt  # type: ignore

    HAS_LIBVIRT = True
except Exception:  # pragma: no cover - sandbox has no libvirt
    libvirt = None  # type: ignore
    HAS_LIBVIRT = False

# Friendly state map
_STATE_MAP = {
    0: "no state",
    1: "running",
    2: "blocked",
    3: "paused",
    4: "shutdown",
    5: "stopped",
    6: "crashed",
    7: "suspended",
}


class LibvirtUnavailable(RuntimeError):
    pass


class HostUnreachable(RuntimeError):
    pass


class VmNotFound(RuntimeError):
    pass


class HostNotFound(KeyError):
    pass


# ---- connection pooling ----------------------------------------------------

_pool_lock = threading.RLock()
_pool: Dict[str, list] = {}  # host -> [conn, lock, last_err]


def _host_uri(host: str) -> str:
    from .config import get_config

    cfg = get_config()
    if host not in cfg.hosts:
        raise HostNotFound(host)
    return cfg.hosts[host]


def _get_conn(host: str):
    if not HAS_LIBVIRT:
        raise LibvirtUnavailable(
            "libvirt-python is not installed in this environment. "
            "Run the app inside the provided Docker image."
        )
    with _pool_lock:
        entry = _pool.get(host)
        if entry is None:
            entry = [None, threading.Lock(), ""]
            _pool[host] = entry
        conn, lock, _ = entry
    with lock:
        if conn is not None:
            try:
                _ = conn.getHostname()
                return conn, lock
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None
        uri = _host_uri(host)
        try:
            conn = libvirt.open(uri)  # read-write
        except libvirt.libvirtError as e:  # type: ignore
            raise HostUnreachable(str(e)) from e
        _pool[host][0] = conn
        return conn, lock


def close_pool() -> None:
    with _pool_lock:
        for entry in _pool.values():
            if entry[0] is not None:
                try:
                    entry[0].close()
                except Exception:
                    pass
                entry[0] = None


def _host_memory_kib(conn) -> int:
    """Total host memory in KiB.

    Prefers virNodeGetMemoryStats('total') — reliable, matches /proc/meminfo,
    always in KiB. Falls back to getInfo()'s memory field (KiB per libvirt docs,
    but has been observed returning 0 / wrong-scale values on some builds).
    """
    for name in ("getMemoryStats", "nodeGetMemoryStats"):
        fn = getattr(conn, name, None)
        if callable(fn):
            try:
                stats = fn(-1, 0)
                if isinstance(stats, dict) and stats.get("total"):
                    return int(stats["total"])
            except Exception:
                continue
    try:
        info = conn.getInfo()
        if info and len(info) > 1 and info[1]:
            return int(info[1])
    except Exception:
        pass
    return 0


# ---- host & VM listing -----------------------------------------------------

def host_status(host: str) -> Dict[str, Any]:
    conn, lock = _get_conn(host)
    with lock:
        try:
            hostname = conn.getHostname()
            info = conn.getInfo()  # (model, memoryKiB, cpus, mhz, nodes, sockets, cores, threads)
            total_vms = conn.numOfDomains()
            active = conn.numOfDomains()
            memory_kib = _host_memory_kib(conn)
            reachable = True
        except Exception as e:
            raise HostUnreachable(str(e))
    return {
        "host": host,
        "uri": _host_uri(host),
        "reachable": reachable,
        "hostname": hostname,
        "cpu_model": info[0],
        "cpus": info[2],
        "mhz": info[3],
        "memory_kib": memory_kib,
        "nodes": info[4],
        "sockets": info[5],
        "cores_per_socket": info[6],
        "threads_per_core": info[7],
        "total_vms": total_vms,
        "active_vms": active,
    }


def _call(obj, primary: str, *fallbacks, default=None):
    """Call the first existing method on a libvirt object.

    libvirt-python names vary a bit across versions, so we try `primary` then
    `fallbacks`. Returns `default` if none exist (never raises), so a missing
    non-essential method can never cause a whole VM to be dropped from the list.
    """
    for name in (primary, *fallbacks):
        fn = getattr(obj, name, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                continue
    return default


def list_vms(host: str) -> List[Dict[str, Any]]:
    conn, lock = _get_conn(host)
    out: List[Dict[str, Any]] = []
    with lock:
        try:
            # Explicit ACTIVE | INACTIVE so we always see running + shutoff
            # domains (flags=0 also returns all, but be unambiguous).
            flags = 0
            if HAS_LIBVIRT:
                flags = (
                    getattr(libvirt, "VIR_CONNECT_LIST_DOMAINS_ACTIVE", 0)
                    | getattr(libvirt, "VIR_CONNECT_LIST_DOMAINS_INACTIVE", 0)
                )
            domains = conn.listAllDomains(flags)
        except Exception as e:
            raise HostUnreachable(str(e))
        for dom in domains:
            # Essential fields — if these genuinely fail, skip the VM.
            name = _call(dom, "name", "getName")
            uuid = _call(dom, "UUIDString", "getUUIDString", default="")
            state_pair = _call(dom, "state", "getState", default=(0, 0))
            info = _call(dom, "info", "getInfo", default=[0, 0, 0, 0, 0])
            if name is None:
                continue
            state_code = int(state_pair[0]) if state_pair else 0
            # Non-essential fields are best-effort: a missing method here must
            # never drop the whole VM from the list.
            autostart = bool(_call(dom, "autostart", "getAutostart", "autostartEnabled", default=0) or 0)
            persistent = bool(_call(dom, "isPersistent", "persistent", default=0) or 0)
            out.append({
                "name": name,
                "uuid": uuid or "",
                "state_code": state_code,
                "state": _STATE_MAP.get(state_code, "unknown"),
                "vcpu": int(info[3]) if info else 0,
                "max_memory_kib": int(info[1]) if info else 0,
                "memory_kib": int(info[2]) if info else 0,
                "cpu_time_ns": int(info[4]) if info else 0,
                "autostart": autostart,
                "persistent": persistent,
            })
    out.sort(key=lambda d: d["name"])
    return out


def _lookup_vm(host: str, vm: str):
    conn, lock = _get_conn(host)
    with lock:
        try:
            return conn.lookupByName(vm), lock
        except Exception:
            try:
                return conn.lookupByUUIDString(vm), lock
            except Exception as e:
                raise VmNotFound(vm) from e


# ---- power actions ---------------------------------------------------------

def _state(host: str, dom) -> str:
    state, _ = dom.state()
    return _STATE_MAP.get(int(state), "unknown")


def power_on(host: str, vm: str) -> Dict[str, Any]:
    dom, lock = _lookup_vm(host, vm)
    with lock:
        try:
            dom.create()
        except Exception as e:
            raise RuntimeError(str(e))
    return {"ok": True, "state": _state(host, dom)}


def power_off(host: str, vm: str) -> Dict[str, Any]:
    dom, lock = _lookup_vm(host, vm)
    with lock:
        try:
            dom.destroy()
        except Exception as e:
            raise RuntimeError(str(e))
    return {"ok": True, "state": _state(host, dom)}


def soft_shutdown(host: str, vm: str) -> Dict[str, Any]:
    dom, lock = _lookup_vm(host, vm)
    with lock:
        try:
            # ACPI power button
            flags = getattr(libvirt, "VIR_DOMAIN_SHUTDOWN_ACPI_POWER_BTN", 0) if HAS_LIBVIRT else 0
            try:
                dom.shutdownFlags(flags)
            except Exception:
                dom.shutdown()  # legacy
        except Exception as e:
            raise RuntimeError(str(e))
    return {"ok": True, "state": _state(host, dom)}


def hard_reset(host: str, vm: str) -> Dict[str, Any]:
    dom, lock = _lookup_vm(host, vm)
    with lock:
        try:
            dom.reset(0)
        except Exception as e:
            raise RuntimeError(str(e))
    return {"ok": True, "state": _state(host, dom)}


def soft_reboot(host: str, vm: str) -> Dict[str, Any]:
    dom, lock = _lookup_vm(host, vm)
    with lock:
        try:
            flags = getattr(libvirt, "VIR_DOMAIN_REBOOT_ACPI_POWER_BTN", 0) if HAS_LIBVIRT else 0
            dom.reboot(flags)
        except Exception as e:
            raise RuntimeError(str(e))
    return {"ok": True, "state": _state(host, dom)}


ACTIONS = {
    "power-on": power_on,
    "power-off": power_off,
    "soft-shutdown": soft_shutdown,
    "soft-reboot": soft_reboot,
    "hard-reset": hard_reset,
}


# ---- statistics -------------------------------------------------------------

def _parse_disks(dom) -> List[str]:
    xml = dom.XMLDesc(0)
    root = ET.fromstring(xml)
    return [t.get("dev") for t in root.iter("target") if t.get("dev")]


def _parse_interfaces(dom) -> List[str]:
    xml = dom.XMLDesc(0)
    root = ET.fromstring(xml)
    return [t.get("dev") for t in root.iter("target") if t.get("dev")]


def vm_stats(host: str, vm: str) -> Dict[str, Any]:
    dom, lock = _lookup_vm(host, vm)
    with lock:
        info = dom.info()  # [state, maxmem, memory, nvcpu, cputime]
        state, _ = dom.state()

        memstats: Dict[str, int] = {}
        try:
            raw = dom.memoryStats()
            memstats = {k: int(v) for k, v in raw.items()} if raw else {}
        except Exception:
            pass

        disks = []
        for dev in _parse_disks(dom):
            entry: Dict[str, Any] = {"device": dev}
            try:
                bs = dom.blockStats(dev)  # (rd_req, wr_req, rd_bytes, wr_bytes, errs)
                entry.update({
                    "rd_req": int(bs[0]),
                    "wr_req": int(bs[1]),
                    "rd_bytes": int(bs[2]),
                    "wr_bytes": int(bs[3]),
                    "errs": int(bs[4]),
                })
            except Exception:
                pass
            try:
                bi = dom.blockInfo(dev, 0)  # (capacity, allocation, physical)
                entry.update({
                    "capacity_bytes": int(bi[0]),
                    "allocation_bytes": int(bi[1]),
                })
            except Exception:
                pass
            disks.append(entry)

        nets = []
        for dev in _parse_interfaces(dom):
            try:
                s = dom.interfaceStats(dev)  # (rx_b, rx_p, rx_err, rx_drop, tx_b, tx_p, tx_err, tx_drop)
                nets.append({
                    "device": dev,
                    "rx_bytes": int(s[0]),
                    "rx_packets": int(s[1]),
                    "rx_errs": int(s[2]),
                    "rx_drops": int(s[3]),
                    "tx_bytes": int(s[4]),
                    "tx_packets": int(s[5]),
                    "tx_errs": int(s[6]),
                    "tx_drops": int(s[7]),
                })
            except Exception:
                continue

    return {
        "host": host,
        "vm": vm,
        "state": _STATE_MAP.get(int(state), "unknown"),
        "vcpu": int(info[3]),
        "max_memory_kib": int(info[1]),
        "memory_kib": int(info[2]),
        "cpu_time_ns": int(info[4]),
        "memory_stats": memstats,
        "disks": disks,
        "net": nets,
    }


# ---- VNC info --------------------------------------------------------------

def vm_vnc_info(host: str, vm: str) -> Dict[str, Any]:
    """Return the VNC port + listen address for a VM by parsing live XML."""
    dom, lock = _lookup_vm(host, vm)
    with lock:
        xml = dom.XMLDesc(getattr(libvirt, "VIR_DOMAIN_XML_SECURE", 0) if HAS_LIBVIRT else 0)
        state, _ = dom.state()
    root = ET.fromstring(xml)
    for g in root.iter("graphics"):
        if g.get("type") == "vnc":
            # autoport VMs report port=-1 in the persistent config; only the
            # *live* XML of a running domain carries the real port (5900+N).
            port = int(g.get("port") or 0)
            if port < 0:
                port = 0
            return {
                "host": host,
                "vm": vm,
                "type": "vnc",
                "port": port,
                "listen": g.get("listen") or g.get("socket") or "127.0.0.1",
                "autoport": g.get("autoport") == "yes",
                "state": _STATE_MAP.get(int(state), "unknown"),
            }
    return {"host": host, "vm": vm, "type": "vnc", "port": 0, "listen": "", "state": _STATE_MAP.get(int(state), "unknown")}


# ---- XML editor (virsh edit equivalent) ------------------------------------

def vm_xml(host: str, vm: str) -> str:
    """Return the domain XML for editing (virsh edit equivalent).

    Prefers the persistent (inactive) definition — what `virsh edit` shows and
    what `virDomainDefineXML` updates. For a transient domain (no persistent
    config) it falls back to the current/live XML.
    """
    dom, lock = _lookup_vm(host, vm)
    with lock:
        flags = 0
        if HAS_LIBVIRT:
            flags = (
                getattr(libvirt, "VIR_DOMAIN_XML_INACTIVE", 0)
                | getattr(libvirt, "VIR_DOMAIN_XML_SECURE", 0)
            )
        try:
            return dom.XMLDesc(flags)
        except Exception:
            # transient domain — return the live XML instead
            try:
                secure = getattr(libvirt, "VIR_DOMAIN_XML_SECURE", 0) if HAS_LIBVIRT else 0
                return dom.XMLDesc(secure)
            except Exception as e:
                raise RuntimeError(str(e)) from e


def vm_dump_xml(host: str, vm: str) -> str:
    """Return the domain XML for export (virsh dumpxml equivalent).

    Returns the LIVE XML (current running state) with flag 0 — passwords are
    masked, exactly like `virsh dumpxml <domain>` with no --security-info flag.
    For a stopped (defined) domain this is the persistent definition.
    """
    dom, lock = _lookup_vm(host, vm)
    with lock:
        try:
            return dom.XMLDesc(0)
        except Exception as e:
            raise RuntimeError(str(e)) from e


def vm_define_xml(host: str, vm: str, xml: str) -> Dict[str, Any]:
    """Validate + apply edited domain XML (virDomainDefineXML).

    Mirrors `virsh edit`: malformed XML or a libvirt rejection raises, so the
    editor keeps the user's text and surfaces the error. A successful define
    updates the persistent config (live state changes on next boot, like virsh).
    """
    # server-side well-formedness check before handing to libvirt
    try:
        ET.fromstring(xml)
    except ET.ParseError as e:
        raise ValueError(f"XML parse error: {e}")
    conn, lock = _get_conn(host)
    with lock:
        try:
            newdom = conn.defineXML(xml)
        except Exception as e:
            raise RuntimeError(str(e)) from e
    name = ""
    try:
        name = newdom.name()
    except Exception:
        pass
    return {"ok": True, "name": name or vm}


def define_domain_xml(host: str, xml: str) -> Dict[str, Any]:
    """Define a NEW domain from XML (virsh define equivalent).

    Accepts a full <domain> XML document, validates well-formedness, then calls
    virDomainDefineXML on the host's connection. Mirrors `virsh define file.xml`:
    malformed XML or a libvirt rejection raises with the libvirt error so the
    dialog can show it and keep the user's text.
    """
    try:
        ET.fromstring(xml)
    except ET.ParseError as e:
        raise ValueError(f"XML parse error: {e}")
    conn, lock = _get_conn(host)
    with lock:
        try:
            newdom = conn.defineXML(xml)
        except Exception as e:
            raise RuntimeError(str(e)) from e
    name = uuid = ""
    try:
        name = newdom.name()
    except Exception:
        pass
    try:
        uuid = newdom.UUIDString()
    except Exception:
        pass
    return {"ok": True, "name": name, "uuid": uuid}

