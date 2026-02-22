# Flipper Zero Web Interface

Browser-based control panel for Flipper Zero over USB serial. Connect your Flipper, open `localhost:8000`, and access all major features without touching the device.

## Features

- **Terminal** — send CLI commands directly, with history (up/down arrows)
- **File Browser** — navigate the SD card, view files, drag-and-drop upload
- **WiFi Scanner** — scan APs and stations via Marauder (ESP32 UART bridge)
- **Sub-GHz** — listen for decoded/raw signals on 315/433/868/915 MHz
- **NFC / RFID** — read NFC tags (13.56 MHz) and RFID cards (125 kHz)
- **Infrared** — learn decoded/raw IR signals, transmit, universal remote (TV/AC/Audio)
- **Remote Control** — virtual D-pad to navigate the Flipper's UI (click = short, hold = long press)
- **Screen Mirror** — live stream of the Flipper's 128x64 LCD at ~3-5 FPS via WebSocket

## Setup

Requires Python 3.10+ and a Flipper Zero connected via USB.

```bash
# Clone
git clone https://github.com/bruno-civongroup/flipper-zero-interface.git
cd flipper-zero-interface

# Create venv and install dependencies
python -m venv venv
venv\Scripts\activate   # Windows
# source venv/bin/activate  # Linux/Mac
pip install -r requirements.txt

# Run
python run.py
```

Open **http://localhost:8000** in your browser.

## Usage

1. Plug in your Flipper Zero via USB
2. Click **Refresh Ports** — the Flipper auto-detects as `COMx` (VID `0483`, PID `5740`)
3. Click **Connect**
4. Use the tabs to access each feature

### Remote Control

The D-pad mirrors the Flipper's physical buttons. Click for a short press, hold 500ms+ for a long press. Works with touch on mobile.

### Screen Mirror

Click **Start Mirror** to stream the Flipper's display in real time. The 128x64 screen is scaled 4x with crisp pixel rendering. Use alongside the Remote tab to fully control the Flipper from your browser.

### Infrared

- **Learn** — point a remote at the Flipper's IR receiver, click Learn to capture the signal
- **Transmit** — replay a captured signal by protocol, address, and command
- **Universal Remote** — built-in TV, AC, and Audio button presets

## Tech Stack

- **Backend:** FastAPI, pyserial, Pillow, uvicorn
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Protocol:** REST API + WebSocket for live features (monitor, screen mirror)

## Project Structure

```
app/
  main.py              # FastAPI app, router registration
  serial_manager.py    # Flipper serial communication (230400 baud)
  file_manager.py      # SD card file operations
  marauder.py          # ESP32 Marauder WiFi interface
  routes/
    serial.py          # /api/serial/* — connect, disconnect, commands
    files.py           # /api/files/* — browse, read, upload
    monitor.py         # /ws/monitor — live status WebSocket
    wifi.py            # /api/wifi/* — Marauder AP/station scanning
    subghz.py          # /api/subghz/* — CC1101 radio
    nfcrfid.py         # /api/nfc/*, /api/rfid/* — tag/card reading
    ir.py              # /api/ir/* — infrared learn/transmit/universal
    input.py           # /api/input/* — button press simulation
    screen.py          # /ws/screen — screen mirror WebSocket
    export.py          # /api/export/* — JSON/CSV download
  static/
    index.html         # Single-page app
    app.js             # Frontend logic
    style.css          # Dark theme UI
run.py                 # Entry point (uvicorn)
```

## License

MIT
