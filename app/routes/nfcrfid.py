"""NFC (13.56 MHz) and RFID (125 kHz) reader endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.serial_manager import flipper
import re

router = APIRouter(prefix="/api", tags=["nfc", "rfid"])


class ScanRequest(BaseModel):
    duration: float = 10.0


class RfidReadRequest(BaseModel):
    duration: float = 10.0
    mode: str = "normal"  # "normal" or "indala"


# ── NFC (13.56 MHz) ──

@router.post("/nfc/scan")
async def nfc_scan(req: ScanRequest):
    """
    Scan for NFC tags using the Flipper's built-in reader.

    Runs the NFC scanner for the specified duration. Place a tag
    on the back of the Flipper during the scan window.
    """
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    duration = min(max(req.duration, 3.0), 60.0)

    try:
        raw = await flipper.send_nfc_command("scanner", duration=duration)
        tags = parse_nfc_scanner(raw)
        return {
            "raw": raw,
            "tags": tags,
            "count": len(tags),
            "duration": duration,
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/nfc/field")
async def nfc_field():
    """Check if the NFC field is active."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    try:
        raw = await flipper.send_nfc_command("field", duration=3.0)
        return {"raw": raw}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/nfc/saved")
async def nfc_saved():
    """List saved NFC captures on the SD card."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    try:
        from app import file_manager
        entries = await file_manager.list_directory("/ext/nfc")
        files = [e for e in entries if e["type"] == "file"]
        return {"files": files, "count": len(files)}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── RFID (125 kHz) ──

@router.post("/rfid/read")
async def rfid_read(req: RfidReadRequest):
    """
    Read 125 kHz RFID cards/tags.

    Hold a card near the Flipper's back during the scan window.
    Supports ASK (normal) and PSK (Indala) modes.
    """
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    duration = min(max(req.duration, 3.0), 60.0)
    mode_arg = "indala" if req.mode == "indala" else "normal"

    try:
        raw = await flipper.send_streaming_command(
            f"rfid read {mode_arg}",
            duration=duration,
        )
        cards = parse_rfid_output(raw)
        return {
            "raw": raw,
            "cards": cards,
            "count": len(cards),
            "duration": duration,
            "mode": mode_arg,
        }
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/rfid/saved")
async def rfid_saved():
    """List saved RFID captures on the SD card."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    try:
        from app import file_manager
        entries = await file_manager.list_directory("/ext/lfrfid")
        files = [e for e in entries if e["type"] == "file"]
        return {"files": files, "count": len(files)}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Parsers ──

def parse_nfc_scanner(raw: str) -> list[dict]:
    """
    Parse NFC scanner output.

    Scanner typically outputs lines like:
      UID: 04 A1 B2 C3 D4 E5 F6
      ATQA: 44 00
      SAK: 08
      Type: Mifare Classic 1K
    or:
      ISO14443-3A UID: AA BB CC DD
    """
    tags = []
    current = {}

    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue

        uid_match = re.search(r"UID:\s*([0-9A-Fa-f\s]+)", line)
        atqa_match = re.search(r"ATQA:\s*([0-9A-Fa-f\s]+)", line)
        sak_match = re.search(r"SAK:\s*([0-9A-Fa-f]+)", line)
        type_match = re.search(r"Type:\s*(.+)", line)

        if uid_match:
            if current.get("uid"):
                tags.append(current)
                current = {}
            current["uid"] = uid_match.group(1).strip()

        if atqa_match:
            current["atqa"] = atqa_match.group(1).strip()
        if sak_match:
            current["sak"] = sak_match.group(1).strip()
        if type_match:
            current["type"] = type_match.group(1).strip()

        # ISO protocol detection
        if "ISO14443-3A" in line:
            current["protocol"] = "ISO14443-3A"
        elif "ISO14443-3B" in line:
            current["protocol"] = "ISO14443-3B"
        elif "ISO14443-4" in line:
            current["protocol"] = "ISO14443-4"
        elif "ISO15693" in line:
            current["protocol"] = "ISO15693"
        elif "Mifare" in line:
            mf_match = re.search(r"(Mifare\s+\S+(?:\s+\S+)?)", line)
            if mf_match:
                current["type"] = mf_match.group(1)
        elif "NTAG" in line:
            ntag_match = re.search(r"(NTAG\d+)", line)
            if ntag_match:
                current["type"] = ntag_match.group(1)

    if current.get("uid"):
        tags.append(current)

    return tags


def parse_rfid_output(raw: str) -> list[dict]:
    """
    Parse RFID read output.

    Typical decoded output:
      Protocol: EM4100
      Data: 01 02 03 04 05
    or:
      EM4100 ID: 0x0102030405
    or:
      HIDProx ID: 12345 FC: 100 Card: 54321
    """
    cards = []
    current = {}

    for line in raw.split("\n"):
        line = line.strip()
        if not line or "Reading" in line or "Press Ctrl" in line or "abort" in line:
            continue

        proto_match = re.search(r"Protocol:\s*(\S+)", line)
        data_match = re.search(r"Data:\s*([0-9A-Fa-f\s]+)", line)
        id_match = re.search(r"ID:\s*(0x[0-9A-Fa-f]+|[0-9A-Fa-f\s]+)", line)
        fc_match = re.search(r"FC:\s*(\d+)", line)
        card_match = re.search(r"Card:\s*(\d+)", line)

        # Protocol-prefixed lines: "EM4100 ID: ..."
        for proto in ["EM4100", "HIDProx", "Indala", "FDX-B", "Viking", "Jablotron", "Paradox", "Keri", "Gallagher"]:
            if line.startswith(proto) or proto in line:
                if current.get("protocol"):
                    cards.append(current)
                    current = {}
                current["protocol"] = proto
                break

        if proto_match:
            if current.get("protocol"):
                cards.append(current)
                current = {}
            current["protocol"] = proto_match.group(1)

        if data_match:
            current["data"] = data_match.group(1).strip()
        if id_match:
            current["id"] = id_match.group(1).strip()
        if fc_match:
            current["facility_code"] = fc_match.group(1)
        if card_match:
            current["card_number"] = card_match.group(1)

    if current.get("protocol") or current.get("id"):
        cards.append(current)

    return cards
