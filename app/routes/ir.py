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

    Decoded signals typically look like:
      Protocol: NEC Address: 04 Command: 08
    or multi-line:
      Protocol: NEC
      Address: 04
      Command: 08
    """
    signals = []
    current = {}

    for line in raw.split("\n"):
        line = line.strip()

        # Skip status/info lines
        if not line or "Waiting" in line or "IR receiver" in line:
            continue
        if "Press CTRL" in line or "Receiving" in line:
            continue

        proto_match = re.search(r"Protocol:\s*(\S+)", line)
        addr_match = re.search(r"Address:\s*([0-9A-Fa-f\s]+?)(?:\s+\w+:|$)", line)
        cmd_match = re.search(r"Command:\s*([0-9A-Fa-f\s]+?)(?:\s+\w+:|$)", line)

        if proto_match:
            if current.get("protocol"):
                signals.append(current)
                current = {}

            current["protocol"] = proto_match.group(1)
            if addr_match:
                current["address"] = addr_match.group(1).strip()
            if cmd_match:
                current["command"] = cmd_match.group(1).strip()

        elif addr_match and current:
            current["address"] = addr_match.group(1).strip()
        elif cmd_match and current:
            current["command"] = cmd_match.group(1).strip()

    if current.get("protocol"):
        signals.append(current)

    return signals
