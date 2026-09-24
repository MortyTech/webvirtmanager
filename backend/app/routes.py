"""REST API routes for hosts, VMs, stats, power actions, and config reload."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from . import libvirt_api as lv
from .config import get_config, reload_config
from .vnc_proxy import create_vnc_session

router = APIRouter(prefix="/api")

PROBE_TIMEOUT = 8.0


def _err(e: Exception, code: int = 400):
    return JSONResponse({"detail": str(e)}, status_code=code)


@router.get("/healthz")
async def healthz():
    cfg = get_config()
    return {
        "status": "ok",
        "oidc_enabled": cfg.oidc.enabled,
        "hosts": len(cfg.hosts),
        "libvirt": lv.HAS_LIBVIRT,
        "loaded_at": cfg.loaded_at,
    }


@router.get("/hosts")
async def list_hosts():
    cfg = get_config()
    names = list(cfg.hosts.keys())

    async def _probe(name: str):
        try:
            return await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(None, lv.host_status, name),
                timeout=PROBE_TIMEOUT,
            )
        except asyncio.TimeoutError:
            return {"host": name, "reachable": False, "error": "timeout connecting to libvirt"}
        except lv.HostUnreachable as e:
            return {"host": name, "reachable": False, "error": str(e)}
        except lv.HostNotFound:
            return {"host": name, "reachable": False, "error": "host removed from config"}
        except lv.LibvirtUnavailable as e:
            return {"host": name, "reachable": False, "error": str(e)}
        except Exception as e:
            return {"host": name, "reachable": False, "error": str(e)}

    results = await asyncio.gather(*[_probe(n) for n in names])
    return {"hosts": results}


@router.get("/hosts/{host}")
async def host_detail(host: str):
    try:
        status = await asyncio.get_event_loop().run_in_executor(None, lv.host_status, host)
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except lv.HostUnreachable as e:
        return {"host": host, "reachable": False, "error": str(e)}
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    return status


@router.get("/hosts/{host}/vms")
async def list_vms(host: str):
    try:
        vms = await asyncio.get_event_loop().run_in_executor(None, lv.list_vms, host)
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except lv.HostUnreachable as e:
        return JSONResponse(
            {"host": host, "reachable": False, "error": str(e), "vms": []},
            status_code=200,
        )
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    return {"host": host, "vms": vms}


@router.get("/hosts/{host}/vms/{vm}")
async def vm_detail(host: str, vm: str):
    try:
        vms = await asyncio.get_event_loop().run_in_executor(None, lv.list_vms, host)
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except (lv.HostUnreachable,) as e:
        raise HTTPException(502, detail=str(e))
    for v in vms:
        if v["name"] == vm or v["uuid"] == vm:
            return v
    raise HTTPException(404, detail=f"unknown vm: {vm}")


@router.post("/hosts/{host}/vms/{vm}/vnc")
async def vm_vnc(host: str, vm: str, request: Request):
    cfg = get_config()
    if host not in cfg.hosts:
        raise HTTPException(404, detail=f"unknown host: {host}")
    uri = cfg.hosts[host]
    # owner session (for binding the token); anonymous if auth disabled
    owner_sid = ""
    session = getattr(request.state, "session", None)
    if session is not None:
        owner_sid = session.sid
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, create_vnc_session, host, vm, owner_sid, uri
        )
    except lv.VmNotFound:
        raise HTTPException(404, detail=f"unknown vm: {vm}")
    except lv.HostUnreachable as e:
        raise HTTPException(502, detail=str(e))
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    except Exception as e:
        raise HTTPException(409, detail=str(e))
    return result


@router.post("/hosts/{host}/vms/{vm}/{action}")
async def vm_action(host: str, vm: str, action: str):
    fn = lv.ACTIONS.get(action)
    if fn is None:
        raise HTTPException(404, detail=f"unknown action: {action}")
    try:
        result = await asyncio.get_event_loop().run_in_executor(None, fn, host, vm)
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except lv.VmNotFound:
        raise HTTPException(404, detail=f"unknown vm: {vm}")
    except lv.HostUnreachable as e:
        raise HTTPException(502, detail=str(e))
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    except Exception as e:
        raise HTTPException(409, detail=str(e))
    return result


@router.get("/hosts/{host}/vms/{vm}/stats")
async def vm_stats(host: str, vm: str):
    try:
        stats = await asyncio.get_event_loop().run_in_executor(None, lv.vm_stats, host, vm)
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except lv.VmNotFound:
        raise HTTPException(404, detail=f"unknown vm: {vm}")
    except lv.HostUnreachable as e:
        raise HTTPException(502, detail=str(e))
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    except Exception as e:
        raise HTTPException(400, detail=str(e))
    return stats


@router.get("/hosts/{host}/vms/{vm}/xml")
async def vm_get_xml(host: str, vm: str, live: bool = False):
    """Return the domain XML.

    - default (live=False): the persistent definition (virsh edit equivalent).
    - ?live=1 : the LIVE XML (virsh dumpxml equivalent, passwords masked).
    """
    fn = lv.vm_dump_xml if live else lv.vm_xml
    try:
        xml = await asyncio.get_event_loop().run_in_executor(None, fn, host, vm)
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except lv.VmNotFound:
        raise HTTPException(404, detail=f"unknown vm: {vm}")
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    except Exception as e:
        raise HTTPException(400, detail=str(e))
    return {"host": host, "vm": vm, "xml": xml}


@router.put("/hosts/{host}/vms/{vm}/xml")
async def vm_save_xml(host: str, vm: str, payload: dict = Body(...)):
    """Apply edited domain XML via virDomainDefineXML.

    Like `virsh edit`: malformed XML or a libvirt rejection returns 400 with the
    error detail so the editor stays open with the user's text intact.
    """
    xml = (payload or {}).get("xml", "")
    if not xml.strip():
        raise HTTPException(400, detail="empty xml")
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lv.vm_define_xml, host, vm, xml
        )
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except lv.VmNotFound:
        raise HTTPException(404, detail=f"unknown vm: {vm}")
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    except ValueError as e:
        raise HTTPException(400, detail=str(e))  # XML parse error
    except Exception as e:
        raise HTTPException(400, detail=str(e))  # libvirt rejection
    return result


@router.post("/hosts/{host}/define-xml")
async def define_vm_from_xml(host: str, payload: dict = Body(...)):
    """Define a NEW domain from pasted/uploaded XML (virsh define equivalent).

    Mirrors `virsh define file.xml`: malformed XML or a libvirt rejection returns
    400 with the error so the dialog stays open with the user's text intact.
    """
    xml = (payload or {}).get("xml", "")
    if not xml.strip():
        raise HTTPException(400, detail="empty xml")
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lv.define_domain_xml, host, xml
        )
    except lv.HostNotFound:
        raise HTTPException(404, detail=f"unknown host: {host}")
    except lv.HostUnreachable as e:
        raise HTTPException(502, detail=str(e))
    except lv.LibvirtUnavailable as e:
        raise HTTPException(503, detail=str(e))
    except ValueError as e:
        raise HTTPException(400, detail=str(e))  # XML parse error
    except Exception as e:
        raise HTTPException(400, detail=str(e))  # libvirt rejection
    return result


@router.post("/config/reload")
async def reload_cfg():
    new = reload_config()
    # rebuild OIDC client on next access
    from . import auth
    auth.reset_client()
    return {
        "ok": True,
        "oidc_enabled": new.oidc.enabled,
        "hosts": list(new.hosts.keys()),
        "loaded_at": new.loaded_at,
    }
