"""Infrared endpoints — learn, transmit, and universal remote control."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.serial_manager import flipper
import re

router = APIRouter(prefix="/api/ir", tags=["ir"])

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
