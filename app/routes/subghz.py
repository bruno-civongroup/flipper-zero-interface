"""Sub-GHz scanner endpoints using Flipper's built-in CC1101 radio."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.serial_manager import flipper
import re

router = APIRouter(prefix="/api/subghz", tags=["subghz"])

# Common Sub-GHz frequency presets
FREQ_PRESETS = {
    "315": {"freq": 315000000, "label": "315 MHz", "desc": "US garage doors, some car keys"},
    "433": {"freq": 433920000, "label": "433.92 MHz", "desc": "EU/US remotes, weather stations, doorbells"},
    "868": {"freq": 868350000, "label": "868.35 MHz", "desc": "EU devices, smart home sensors"},
    "915": {"freq": 915000000, "label": "915 MHz", "desc": "US ISM band, LoRa devices"},
}


class ListenRequest(BaseModel):
    frequency: int = 433920000
    duration: float = 10.0
    device: int = 0  # 0 = internal CC1101, 1 = external


class TxFileRequest(BaseModel):
    file_path: str
    repeat: int = 1
    device: int = 0


@router.get("/presets")
async def get_presets():
    """Get common Sub-GHz frequency presets."""
    return {"presets": FREQ_PRESETS}


@router.post("/listen")
async def listen(req: ListenRequest):
    """
    Listen for Sub-GHz signals on a given frequency.

    Runs subghz rx for the specified duration, then stops and returns
    any decoded signals.
    """
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    # Clamp duration
    duration = min(max(req.duration, 3.0), 60.0)

    try:
        raw = await flipper.send_streaming_command(
            f"subghz rx {req.frequency} {req.device}",
            duration=duration,
        )
        signals = parse_subghz_output(raw)
        return {
            "raw": raw,
            "frequency": req.frequency,
            "frequency_mhz": req.frequency / 1_000_000,
            "duration": duration,
            "signals": signals,
            "count": len(signals),
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/listen/raw")
async def listen_raw(req: ListenRequest):
    """Listen for raw Sub-GHz data (unprocessed captures)."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    duration = min(max(req.duration, 3.0), 60.0)

    try:
        raw = await flipper.send_streaming_command(
            f"subghz rx_raw {req.frequency}",
            duration=duration,
        )
        return {
            "raw": raw,
            "frequency": req.frequency,
            "frequency_mhz": req.frequency / 1_000_000,
            "duration": duration,
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/saved")
async def list_saved():
    """List saved Sub-GHz captures on the SD card."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    try:
        from app import file_manager
        entries = await file_manager.list_directory("/ext/subghz")
        files = [e for e in entries if e["type"] == "file"]
        return {"files": files, "count": len(files)}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/transmit")
async def transmit_from_file(req: TxFileRequest):
    """Transmit a saved Sub-GHz capture file."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    try:
        result = await flipper.send_command(
            f"subghz tx_from_file {req.file_path} {req.repeat} {req.device}",
            timeout=10.0,
        )
        return {"file": req.file_path, "repeat": req.repeat, "result": result}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def parse_subghz_output(raw: str) -> list[dict]:
    """
    Parse subghz rx output into structured signal data.

    Decoded signals typically look like:
      Protocol: Princeton
      Bit: 24
      Key: 00 A0 5E
      TE: 350
    or single-line:
      Protocol: Princeton Bit: 24 Key: 00 A0 5E TE: 350
    """
    signals = []
    current = {}

    for line in raw.split("\n"):
        line = line.strip()

        # Skip status/info lines
        if not line or "Listening" in line or "Load_keystore" in line:
            continue
        if "Press CTRL" in line or "frequency" in line.lower():
            continue

        # Try to extract key-value pairs from the line
        # Multi-field single line: "Protocol: X Bit: Y Key: Z TE: W"
        proto_match = re.search(r"Protocol:\s*(\S+)", line)
        bit_match = re.search(r"Bit:\s*(\d+)", line)
        key_match = re.search(r"Key:\s*([0-9A-Fa-f\s]+?)(?:\s+\w+:|$)", line)
        te_match = re.search(r"TE:\s*(\d+)", line)

        if proto_match:
            # If we already have a signal building, save it
            if current.get("protocol"):
                signals.append(current)
                current = {}

            current["protocol"] = proto_match.group(1)
            if bit_match:
                current["bits"] = int(bit_match.group(1))
            if key_match:
                current["key"] = key_match.group(1).strip()
            if te_match:
                current["te"] = int(te_match.group(1))

        elif bit_match and current:
            current["bits"] = int(bit_match.group(1))
        elif key_match and current:
            current["key"] = key_match.group(1).strip()
        elif te_match and current:
            current["te"] = int(te_match.group(1))

    # Don't forget the last one
    if current.get("protocol"):
        signals.append(current)

    return signals
