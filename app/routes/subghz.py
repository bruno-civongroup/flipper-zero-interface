"""Sub-GHz scanner endpoints using Flipper's built-in CC1101 radio."""

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.serial_manager import flipper
import re

router = APIRouter(prefix="/api/subghz", tags=["subghz"])

# Persistent Sub-GHz signal library — stored alongside the app
SUBGHZ_SIGNALS_FILE = Path(__file__).parent.parent.parent / "subghz_signals.json"


def _load_subghz_signals() -> list[dict]:
    if SUBGHZ_SIGNALS_FILE.exists():
        return json.loads(SUBGHZ_SIGNALS_FILE.read_text())
    return []


def _save_subghz_signals(signals: list[dict]):
    SUBGHZ_SIGNALS_FILE.write_text(json.dumps(signals, indent=2))

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


class SaveSubghzSignalRequest(BaseModel):
    name: str
    protocol: str
    key: str
    bits: int = 24
    frequency: int = 433920000
    te: int | None = None


@router.get("/signals")
async def get_subghz_signals():
    """List all saved Sub-GHz signals from the local library."""
    signals = _load_subghz_signals()
    return {"signals": signals, "count": len(signals)}


@router.post("/signals")
async def save_subghz_signal(req: SaveSubghzSignalRequest):
    """Save a Sub-GHz signal to the local library."""
    signals = _load_subghz_signals()
    sig = {
        "id": str(uuid.uuid4())[:8],
        "name": req.name.strip(),
        "protocol": req.protocol,
        "key": req.key,
        "bits": req.bits,
        "frequency": req.frequency,
        "te": req.te,
    }
    signals.append(sig)
    _save_subghz_signals(signals)
    return sig


@router.delete("/signals/{signal_id}")
async def delete_subghz_signal(signal_id: str):
    """Delete a Sub-GHz signal from the local library."""
    signals = _load_subghz_signals()
    before = len(signals)
    signals = [s for s in signals if s["id"] != signal_id]
    if len(signals) == before:
        raise HTTPException(status_code=404, detail="Signal not found")
    _save_subghz_signals(signals)
    return {"deleted": signal_id}


@router.post("/signals/{signal_id}/transmit")
async def transmit_subghz_signal(signal_id: str):
    """Transmit a saved Sub-GHz signal."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    signals = _load_subghz_signals()
    sig = next((s for s in signals if s["id"] == signal_id), None)
    if not sig:
        raise HTTPException(status_code=404, detail="Signal not found")

    try:
        # Format key: ensure 0x prefix and pad to appropriate length
        key = sig["key"].strip()
        if not key.startswith("0x") and not key.startswith("0X"):
            key = "0x" + key.replace(" ", "")
        result = await flipper.send_command(
            f"subghz tx {key} {sig['frequency']} {sig.get('te', 400) or 400}",
            timeout=10.0,
        )
        return {
            "name": sig["name"],
            "protocol": sig["protocol"],
            "key": sig["key"],
            "frequency": sig["frequency"],
            "result": result,
        }
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
