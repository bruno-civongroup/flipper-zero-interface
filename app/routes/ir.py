"""Infrared endpoints — learn, transmit, universal remote, signal library, and IRDB import."""

import json
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.serial_manager import flipper
import re

router = APIRouter(prefix="/api/ir", tags=["ir"])

# Persistent signal library — stored alongside the app
SIGNALS_FILE = Path(__file__).parent.parent.parent / "signals.json"


def _load_signals() -> list[dict]:
    if SIGNALS_FILE.exists():
        return json.loads(SIGNALS_FILE.read_text())
    return []


def _save_signals(signals: list[dict]):
    SIGNALS_FILE.write_text(json.dumps(signals, indent=2))

# Supported IR protocols on the Flipper Zero
IR_PROTOCOLS = [
    "NEC", "NECext", "NEC42", "NEC42ext",
    "Samsung32", "RC5", "RC5X", "RC6",
    "SIRC", "SIRC15", "SIRC20",
    "Kaseikyo", "RCA",
]

# Universal remote button maps
UNIVERSAL_REMOTES = {
    "tv": {
        "label": "TV",
        "buttons": ["power", "vol_up", "vol_down", "ch_up", "ch_down", "mute"],
    },
    "ac": {
        "label": "AC",
        "buttons": ["off", "cool_hi", "cool_lo", "heat_hi", "heat_lo", "dh"],
    },
    "audio": {
        "label": "Audio",
        "buttons": ["power", "vol_up", "vol_down", "mute", "next", "prev"],
    },
}


class LearnRequest(BaseModel):
    duration: float = 10.0


class TransmitRequest(BaseModel):
    protocol: str
    address: str
    command: str


class UniversalRequest(BaseModel):
    remote_type: str
    button: str


@router.get("/protocols")
async def get_protocols():
    """List supported IR protocols."""
    return {"protocols": IR_PROTOCOLS}


@router.get("/universal")
async def get_universal_remotes():
    """List available universal remote types and their buttons."""
    return {"remotes": UNIVERSAL_REMOTES}


@router.post("/learn")
async def learn(req: LearnRequest):
    """
    Learn a decoded IR signal.

    Runs `ir rx` for the specified duration, parses protocol/address/command
    from the output.
    """
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    duration = min(max(req.duration, 3.0), 60.0)

    try:
        raw = await flipper.send_streaming_command("ir rx", duration=duration)
        signals = parse_ir_output(raw)
        return {
            "raw": raw,
            "duration": duration,
            "signals": signals,
            "count": len(signals),
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/learn/raw")
async def learn_raw(req: LearnRequest):
    """Learn a raw (unprocessed) IR signal."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    duration = min(max(req.duration, 3.0), 60.0)

    try:
        raw = await flipper.send_streaming_command("ir rx raw", duration=duration)
        return {
            "raw": raw,
            "duration": duration,
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/transmit")
async def transmit(req: TransmitRequest):
    """Transmit a decoded IR signal with protocol, address, and command."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    try:
        result = await flipper.send_command(
            f"ir tx {req.protocol} {req.address} {req.command}",
            timeout=5.0,
        )
        return {
            "protocol": req.protocol,
            "address": req.address,
            "command": req.command,
            "result": result,
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/universal")
async def universal_remote(req: UniversalRequest):
    """Send a universal remote command (TV, AC, Audio)."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    remote_type = req.remote_type.lower()
    button = req.button.lower()

    if remote_type not in UNIVERSAL_REMOTES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid remote type '{remote_type}'. Valid: {', '.join(UNIVERSAL_REMOTES.keys())}",
        )
    if button not in UNIVERSAL_REMOTES[remote_type]["buttons"]:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid button '{button}' for {remote_type}. Valid: {', '.join(UNIVERSAL_REMOTES[remote_type]['buttons'])}",
        )

    try:
        result = await flipper.send_command(
            f"ir universal {remote_type} {button}",
            timeout=10.0,
        )
        return {
            "remote_type": remote_type,
            "button": button,
            "result": result,
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/saved")
async def list_saved():
    """List saved IR captures on the SD card."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    try:
        from app import file_manager
        entries = await file_manager.list_directory("/ext/infrared")
        files = [e for e in entries if e["type"] == "file"]
        return {"files": files, "count": len(files)}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Signal Library (persistent local storage) ──

class SaveSignalRequest(BaseModel):
    name: str
    protocol: str
    address: str
    command: str


@router.get("/signals")
async def get_signals():
    """List all saved signals from the local library."""
    signals = _load_signals()
    return {"signals": signals, "count": len(signals)}


@router.post("/signals")
async def save_signal(req: SaveSignalRequest):
    """Save a signal to the local library."""
    signals = _load_signals()
    sig = {
        "id": str(uuid.uuid4())[:8],
        "name": req.name.strip(),
        "protocol": req.protocol,
        "address": req.address,
        "command": req.command,
    }
    signals.append(sig)
    _save_signals(signals)
    return sig


@router.delete("/signals/{signal_id}")
async def delete_signal(signal_id: str):
    """Delete a signal from the local library."""
    signals = _load_signals()
    before = len(signals)
    signals = [s for s in signals if s["id"] != signal_id]
    if len(signals) == before:
        raise HTTPException(status_code=404, detail="Signal not found")
    _save_signals(signals)
    return {"deleted": signal_id}


@router.post("/signals/{signal_id}/transmit")
async def transmit_saved(signal_id: str):
    """Transmit a saved signal from the library."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    signals = _load_signals()
    sig = next((s for s in signals if s["id"] == signal_id), None)
    if not sig:
        raise HTTPException(status_code=404, detail="Signal not found")

    try:
        result = await flipper.send_command(
            f"ir tx {sig['protocol']} {sig['address']} {sig['command']}",
            timeout=5.0,
        )
        return {
            "name": sig["name"],
            "protocol": sig["protocol"],
            "address": sig["address"],
            "command": sig["command"],
            "result": result,
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── IRDB (Flipper-IRDB from GitHub) ──

IRDB_REPO = "Lucaslhm/Flipper-IRDB"
IRDB_BRANCH = "main"
IRDB_CACHE_TTL = 600  # 10 minutes
_irdb_dir_cache: dict = {}  # path -> {"data": [...], "time": float}

# Directories to hide from browsing
_IRDB_HIDDEN = {".github", "_Converted_"}


async def _get_irdb_contents(path: str = "") -> list[dict]:
    """Fetch directory contents from GitHub Contents API (cached per path)."""
    now = time.time()
    if path in _irdb_dir_cache and now - _irdb_dir_cache[path]["time"] < IRDB_CACHE_TTL:
        return _irdb_dir_cache[path]["data"]

    url = f"https://api.github.com/repos/{IRDB_REPO}/contents/{path}?ref={IRDB_BRANCH}"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers={"Accept": "application/vnd.github+json"})
        if resp.status_code == 403:
            reset = resp.headers.get("x-ratelimit-reset")
            if reset:
                wait_min = max(1, int((int(reset) - now) / 60))
                raise HTTPException(
                    status_code=429,
                    detail=f"GitHub API rate limited. Try again in ~{wait_min} minute(s).",
                )
            raise HTTPException(status_code=429, detail="GitHub API rate limited. Try again later.")
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"GitHub API error: {resp.status_code}")
        data = resp.json()

    _irdb_dir_cache[path] = {"data": data, "time": now}
    return data


@router.get("/irdb/browse")
async def irdb_browse(path: str = ""):
    """
    Browse the IRDB at any level.

    Fetches directory contents on demand via the GitHub Contents API,
    which avoids the truncation issue with recursive tree fetches.
    Returns immediate children (directories and .ir files) at the given path.
    """
    contents = await _get_irdb_contents(path)

    children = []
    for item in contents:
        name = item["name"]
        if name in _IRDB_HIDDEN:
            continue
        if item["type"] == "dir":
            children.append({"name": name, "type": "directory"})
        elif item["type"] == "file" and name.endswith(".ir"):
            children.append({"name": name, "type": "file", "size": item.get("size", 0)})

    children.sort(key=lambda x: (x["type"] != "directory", x["name"].lower()))
    return {"path": path, "children": children}


@router.get("/irdb/file")
async def irdb_file(path: str):
    """Fetch and parse an .ir file from the IRDB. Returns parsed signals."""
    if not path.endswith(".ir"):
        raise HTTPException(status_code=400, detail="Not an .ir file")

    url = f"https://raw.githubusercontent.com/{IRDB_REPO}/{IRDB_BRANCH}/{path}"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url)
        if resp.status_code == 403:
            raise HTTPException(status_code=429, detail="GitHub rate limited. Try again later.")
        if resp.status_code != 200:
            raise HTTPException(status_code=404, detail="File not found in IRDB")
        content = resp.text

    signals = parse_ir_file(content)
    return {
        "path": path,
        "filename": path.split("/")[-1],
        "signals": signals,
        "count": len(signals),
    }


class IrdbImportRequest(BaseModel):
    signals: list[dict]  # Each: {name, protocol, address, command}


@router.post("/irdb/import")
async def irdb_import(req: IrdbImportRequest):
    """Import signals from IRDB into the local library."""
    library = _load_signals()
    imported = []
    for sig in req.signals:
        name = sig.get("name", "").strip()
        protocol = sig.get("protocol", "")
        address = sig.get("address", "")
        command = sig.get("command", "")
        if not name or not protocol:
            continue
        entry = {
            "id": str(uuid.uuid4())[:8],
            "name": name,
            "protocol": protocol,
            "address": address,
            "command": command,
        }
        library.append(entry)
        imported.append(entry)
    _save_signals(library)
    return {"imported": len(imported), "signals": imported}


def parse_ir_file(content: str) -> list[dict]:
    """
    Parse a Flipper .ir file into a list of signal dicts.

    Handles both 'parsed' (decoded protocol) and 'raw' (timing data) types.
    Parsed signals get protocol/address/command extracted.
    Raw signals get frequency/duty_cycle noted but are marked as raw.

    Address/command in .ir files use "07 00 00 00" format (space-separated
    little-endian bytes). We convert to "0x07" style for consistency with
    the Flipper CLI `ir tx` command.
    """
    signals = []
    current: dict = {}

    for line in content.split("\n"):
        line = line.strip()

        if not line or line.startswith("#") or line.startswith("Filetype:") or line.startswith("Version:"):
            # End of a signal block — save if we have one
            if current.get("name"):
                signals.append(current)
                current = {}
            continue

        if line.startswith("name: "):
            if current.get("name"):
                signals.append(current)
            current = {"name": line[6:].strip()}
        elif line.startswith("type: "):
            current["type"] = line[6:].strip()
        elif line.startswith("protocol: "):
            current["protocol"] = line[10:].strip()
        elif line.startswith("address: "):
            raw_addr = line[9:].strip()
            current["address"] = _ir_bytes_to_hex(raw_addr)
            current["address_raw"] = raw_addr
        elif line.startswith("command: "):
            raw_cmd = line[9:].strip()
            current["command"] = _ir_bytes_to_hex(raw_cmd)
            current["command_raw"] = raw_cmd
        elif line.startswith("frequency: "):
            current["frequency"] = int(line[11:].strip())
        elif line.startswith("duty_cycle: "):
            current["duty_cycle"] = float(line[12:].strip())
        elif line.startswith("data: "):
            current["raw_data"] = line[6:].strip()

    # Don't forget the last signal
    if current.get("name"):
        signals.append(current)

    return signals


def _ir_bytes_to_hex(raw: str) -> str:
    """
    Convert .ir file address/command format to CLI-compatible hex.

    .ir format: "07 00 00 00" (space-separated bytes, little-endian, zero-padded to 4 bytes)
    CLI format: "0x07" (compact hex prefix)

    Strips trailing zero bytes and converts to 0x-prefixed hex.
    """
    parts = raw.split()
    # Strip trailing 00 bytes
    while len(parts) > 1 and parts[-1] == "00":
        parts.pop()
    # Reverse for big-endian reading and join
    hex_str = "".join(parts[::-1])
    # Remove leading zeros but keep at least one digit
    hex_str = hex_str.lstrip("0") or "0"
    return f"0x{hex_str}"


def parse_ir_output(raw: str) -> list[dict]:
    """
    Parse ir rx output into structured signal data.

    The Flipper CLI outputs signals in compact format:
      NEC, A:0x04, C:0x08
      NEC, A:0x04, C:0x08 R       (R = repeat)
      Samsung32, A:0x07, C:0xE0
    Also handles verbose format (older firmware / docs):
      Protocol: NEC Address: 04 Command: 08
    """
    signals = []

    for line in raw.split("\n"):
        line = line.strip()

        # Skip status/info lines
        if not line or "Receiving" in line or "Press Ctrl" in line:
            continue
        if line.startswith(">") or "INFRARED" in line:
            continue

        # Compact format: "NEC, A:0x04, C:0x08" or "NEC, A:0x04, C:0x08 R"
        compact = re.match(
            r"^(\w+),\s*A:(0x[0-9A-Fa-f]+),\s*C:(0x[0-9A-Fa-f]+)(\s+R)?$",
            line,
        )
        if compact:
            signals.append({
                "protocol": compact.group(1),
                "address": compact.group(2),
                "command": compact.group(3),
                "repeat": bool(compact.group(4)),
            })
            continue

        # Verbose format: "Protocol: NEC Address: 04 Command: 08"
        proto_match = re.search(r"Protocol:\s*(\S+)", line)
        if proto_match:
            sig = {"protocol": proto_match.group(1)}
            addr_match = re.search(r"Address:\s*([0-9A-Fa-fx\s]+?)(?:\s+\w+:|$)", line)
            cmd_match = re.search(r"Command:\s*([0-9A-Fa-fx\s]+?)(?:\s+\w+:|$)", line)
            if addr_match:
                sig["address"] = addr_match.group(1).strip()
            if cmd_match:
                sig["command"] = cmd_match.group(1).strip()
            signals.append(sig)

    return signals
