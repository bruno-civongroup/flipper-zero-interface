"""WiFi scanning endpoints via Marauder on ESP32 Dev Board.

Supports two modes:
  1. Direct USB: ESP32 connected to PC via its own USB cable (marauder.py)
  2. JS Bridge: Commands routed through Flipper UART via JS scripts
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.marauder import marauder
from app.serial_manager import flipper
import re

router = APIRouter(prefix="/api/wifi", tags=["wifi"])

# ── JS Bridge scripts for UART-only mode ──

SCAN_AP_SCRIPT = """\
let serial = require("serial");
serial.setup("usart", 115200);
delay(300);

// Flush any old data
let f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }

// Stop any previous scan
serial.write("stopscan\\n");
delay(1500);
f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }

// Enable channel hopping and start scan
serial.write("channel -h\\n");
delay(500);
f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }

serial.write("scanap\\n");

// Read continuously during scan to prevent UART buffer overflow
// 150 iterations * ~100ms = ~15 seconds of scanning
for (let i = 0; i < 150; i++) {
    serial.readAny(100);
}

// Stop the scan
serial.write("stopscan\\n");

// Drain stop confirmation output
for (let i = 0; i < 20; i++) {
    serial.readAny(100);
}

// Get the clean AP list
serial.write("list -a\\n");
delay(2000);
let out = "";
let c = serial.readAny(1000);
while (c !== undefined) {
    out += c;
    c = serial.readAny(500);
}
print(out);
serial.end();
"""

SCAN_STA_SCRIPT = """\
let serial = require("serial");
serial.setup("usart", 115200);
delay(300);

let f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }

serial.write("stopscan\\n");
delay(1000);
f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }

serial.write("scansta\\n");

// Read continuously for ~20 seconds
for (let i = 0; i < 200; i++) {
    serial.readAny(100);
}

serial.write("stopscan\\n");
for (let i = 0; i < 20; i++) {
    serial.readAny(100);
}

serial.write("list -s\\n");
delay(2000);
let out = "";
let c = serial.readAny(1000);
while (c !== undefined) {
    out += c;
    c = serial.readAny(500);
}
print(out);
serial.end();
"""

STOP_SCAN_SCRIPT = """\
let serial = require("serial");
serial.setup("usart", 115200);
delay(300);
let f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }
serial.write("stopscan\\n");
delay(1500);
let out = "";
let c = serial.readAny(500);
while (c !== undefined) {
    out += c;
    c = serial.readAny(200);
}
print(out);
serial.end();
"""

RAW_CMD_TEMPLATE = """\
let serial = require("serial");
serial.setup("usart", 115200);
delay(200);
serial.readAny(200);
serial.write("{cmd}\\n");
delay({wait});
let out = "";
let c = serial.readAny(500);
while (c !== undefined) {{
    out += c;
    c = serial.readAny(200);
}}
print(out);
serial.end();
"""

SCRIPTS_PATH = "/ext/apps/Scripts"
SCRIPT_MAP = {
    "scan_ap": ("mrd_scan_ap.js", SCAN_AP_SCRIPT),
    "scan_sta": ("mrd_scan_sta.js", SCAN_STA_SCRIPT),
    "stop": ("mrd_stop.js", STOP_SCAN_SCRIPT),
}

_scripts_uploaded = False  # Reset on server restart


async def ensure_scripts():
    """Upload JS bridge scripts to Flipper if not already done."""
    global _scripts_uploaded
    if _scripts_uploaded:
        return
    for key, (filename, content) in SCRIPT_MAP.items():
        path = f"{SCRIPTS_PATH}/{filename}"
        await flipper.write_file(path, content)
    _scripts_uploaded = True


class ConnectRequest(BaseModel):
    port: str | None = None


class CommandRequest(BaseModel):
    command: str
    read_time: float = 2.0


class RawMarauderCmd(BaseModel):
    command: str
    wait_ms: int = 2000


# ── Direct USB endpoints (when ESP32 USB is connected) ──

@router.get("/ports")
async def list_ports():
    return {"ports": marauder.list_candidate_ports()}


@router.get("/status")
async def status():
    return {
        "connected": marauder.connected,
        "scanning": marauder.scanning,
        "mode": "direct" if marauder.connected else "bridge",
    }


@router.post("/connect")
async def connect(req: ConnectRequest = ConnectRequest()):
    try:
        device = await marauder.connect(req.port)
        return {"connected": True, "port": device, "mode": "direct"}
    except ConnectionError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/disconnect")
async def disconnect():
    await marauder.disconnect()
    return {"connected": False}


@router.post("/command")
async def send_command(req: CommandRequest):
    try:
        response = await marauder.send_command(req.command, read_time=req.read_time)
        return {"command": req.command, "response": response}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ── Unified scan endpoints (auto-select direct vs bridge) ──

@router.post("/scan/ap")
async def scan_access_points():
    """Scan for WiFi access points."""
    try:
        if marauder.connected:
            raw = await marauder.scan_aps()
        else:
            # Use JS bridge through Flipper UART
            if not flipper.connected:
                raise ConnectionError("Flipper not connected")
            await ensure_scripts()
            raw = await flipper.run_js(
                f"{SCRIPTS_PATH}/mrd_scan_ap.js", timeout=20.0
            )

        aps = parse_ap_list(raw)
        return {"raw": raw, "access_points": aps, "count": len(aps)}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/scan/station")
async def scan_stations():
    """Scan for WiFi client stations."""
    try:
        if marauder.connected:
            raw = await marauder.scan_stations()
        else:
            if not flipper.connected:
                raise ConnectionError("Flipper not connected")
            await ensure_scripts()
            raw = await flipper.run_js(
                f"{SCRIPTS_PATH}/mrd_scan_sta.js", timeout=25.0
            )

        stations = parse_station_list(raw)
        return {"raw": raw, "stations": stations, "count": len(stations)}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/scan/stop")
async def stop_scan():
    """Stop any active scan."""
    try:
        if marauder.connected:
            result = await marauder.send_command("stopscan", read_time=1.0)
        else:
            if not flipper.connected:
                raise ConnectionError("Flipper not connected")
            await ensure_scripts()
            result = await flipper.run_js(
                f"{SCRIPTS_PATH}/mrd_stop.js", timeout=10.0
            )
        return {"result": result}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/scan/raw")
async def raw_marauder_command(req: RawMarauderCmd):
    """Send an arbitrary Marauder command via JS bridge."""
    try:
        if marauder.connected:
            result = await marauder.send_command(req.command, read_time=req.wait_ms / 1000)
        else:
            if not flipper.connected:
                raise ConnectionError("Flipper not connected")
            # Write a one-off script for this command
            script = RAW_CMD_TEMPLATE.format(cmd=req.command, wait=req.wait_ms)
            path = f"{SCRIPTS_PATH}/mrd_raw.js"
            await flipper.write_file(path, script)
            result = await flipper.run_js(path, timeout=req.wait_ms / 1000 + 10)
        return {"command": req.command, "response": result}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ── Parsers ──

def parse_ap_list(raw: str) -> list[dict]:
    aps = []

    # Only parse lines after "list -a" command output
    in_list = False
    lines_to_parse = []
    for line in raw.split("\n"):
        stripped = line.strip()
        if "list -a" in stripped:
            in_list = True
            continue
        if in_list:
            lines_to_parse.append(stripped)

    # If we didn't find "list -a", fall back to parsing everything
    if not lines_to_parse:
        lines_to_parse = [l.strip() for l in raw.split("\n")]

    for line in lines_to_parse:
        if not line or line.startswith("APs") or line.startswith("---"):
            continue
        if line.startswith("#") or line.startswith(">") or "selected" in line:
            continue
        if "Script" in line or "Running" in line or "press CTRL" in line:
            continue
        if "Stopping" in line or "Beacon:" in line or "tran/recv" in line:
            continue

        # Marauder format A: "[idx][CH:ch] BSSID RSSI SSID"
        # e.g. "[0][CH:3] 7a:c9:e3:c7:5b:05 -80 MyNetwork"
        m = re.match(
            r"\[(\d+)\]\[CH:(\d+)\]\s+([0-9A-Fa-f:]{17})\s+(-?\d+)\s*(.*)",
            line,
        )
        if m:
            aps.append({
                "index": int(m.group(1)),
                "channel": int(m.group(2)),
                "bssid": m.group(3),
                "rssi": int(m.group(4)),
                "ssid": m.group(5).strip() or "(hidden)",
                "encryption": "Unknown",
            })
            continue

        # Marauder format A2: "[idx][CH:ch] SSID RSSI" (no BSSID)
        # e.g. "[0][CH:4] PYS2Roars -54"
        m = re.match(
            r"\[(\d+)\]\[CH:(\d+)\]\s+(.+?)\s+(-?\d+)\s*$",
            line,
        )
        if m:
            aps.append({
                "index": int(m.group(1)),
                "channel": int(m.group(2)),
                "bssid": "",
                "rssi": int(m.group(4)),
                "ssid": m.group(3).strip() or "(hidden)",
                "encryption": "Unknown",
            })
            continue

        # Marauder format B: "idx) SSID RSSI CH BSSID Enc"
        m = re.match(
            r"(\d+)\)\s+(.+?)\s+(-?\d+)\s+(\d+)\s+([0-9A-Fa-f:]{17})\s*(\S*)",
            line,
        )
        if m:
            aps.append({
                "index": int(m.group(1)),
                "ssid": m.group(2).strip(),
                "rssi": int(m.group(3)),
                "channel": int(m.group(4)),
                "bssid": m.group(5),
                "encryption": m.group(6) or "Unknown",
            })
            continue

        # Fallback: any line with a MAC address
        mac_match = re.search(r"([0-9A-Fa-f:]{17})", line)
        if mac_match:
            # Try to extract RSSI
            rssi_match = re.search(r"(-?\d{2,3})", line.split(mac_match.group(1))[-1])
            aps.append({
                "index": len(aps),
                "bssid": mac_match.group(1),
                "rssi": int(rssi_match.group(1)) if rssi_match else None,
                "channel": None,
                "ssid": "(unknown)",
                "encryption": "Unknown",
            })

    return aps


def parse_station_list(raw: str) -> list[dict]:
    stations = []
    for line in raw.split("\n"):
        line = line.strip()
        mac_match = re.search(r"([0-9A-Fa-f:]{17})", line)
        if mac_match and not line.startswith("---"):
            stations.append({
                "index": len(stations),
                "mac": mac_match.group(1),
                "raw": line,
            })
    return stations
