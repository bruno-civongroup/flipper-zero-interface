# Flipper Zero Web Interface

Browser-based control panel for Flipper Zero over USB. Uses the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) to talk directly to the Flipper — no backend, no drivers, no install. Just open the page in Chrome or Edge and connect.

**Live:** [projects.brunomalnovic.com](https://projects.brunomalnovic.com)

## Features

- **Terminal** — send CLI commands with history, tab-autocomplete, and Ctrl+R reverse search
- **File Browser** — navigate the SD card, view files, rename, delete, drag-and-drop upload (binary-safe)
- **WiFi Scanner** — scan APs and stations via Marauder (ESP32 over Flipper UART bridge)
- **Sub-GHz** — listen for decoded/raw signals on 315/433/868/915 MHz, save and replay signals
- **NFC / RFID** — read NFC tags (13.56 MHz) and RFID cards (125 kHz), save to persistent library
- **Infrared** — learn decoded/raw IR signals, transmit, universal remote (TV/AC/Audio), import from [Flipper-IRDB](https://github.com/Lucaslhm/Flipper-IRDB)
- **Remote Control** — virtual D-pad (click = short press, hold 500ms+ = long press)
- **Screen Mirror** — live stream of the Flipper's 128x64 LCD at ~3-5 FPS with screenshot capture
- **Signal Libraries** — save, export, and import signal collections (IR, Sub-GHz, NFC, RFID) as JSON, persisted in localStorage

## Requirements

- **Browser:** Chrome or Edge (desktop) — Firefox and Safari do not support Web Serial
- **Hardware:** Flipper Zero connected via USB
- **WiFi scanning** additionally requires an ESP32 with Marauder firmware connected to the Flipper's GPIO UART

## Usage

1. Open the app in Chrome/Edge
2. Click **Connect Flipper** (or press `Ctrl+K`)
3. Select your Flipper's serial port in the browser picker
4. Use the tabs to access each feature

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+1` through `Ctrl+8` | Switch tabs |
| `Ctrl+/` | Focus terminal |
| `Ctrl+K` | Connect/disconnect |
| `Ctrl+R` (in terminal) | Reverse search history |
| `Tab` (in terminal) | Autocomplete commands |

## Project Structure

```
index.html                 # Single-page app
style.css                  # Dark theme UI
_headers                   # Cloudflare Pages HTTP headers
js/
  app.js                   # Main application logic (~1500 lines)
  ExportHelper.js          # JSON/CSV download helpers
  serial/
    FlipperSerial.js       # Web Serial driver (230400 baud, CLI protocol)
    MarauderSerial.js      # ESP32 Marauder UART bridge
    ScreenMirror.js        # Protobuf RPC screen streaming
    Mutex.js               # Serial port lock
  parsers/
    FileParser.js          # SD card file listing parser
    IrParser.js            # IR signal and .ir file parser
    SubghzParser.js        # Sub-GHz signal parser
    NfcRfidParser.js       # NFC/RFID scan output parser
    WifiParser.js          # Marauder AP/station list parser
  storage/
    SignalStore.js          # localStorage-backed signal library
```

## Development

No build step. Open `index.html` directly or serve with any static server:

```bash
npx serve .
```

## Deployment

Hosted on Cloudflare Pages:

```bash
npx wrangler pages deploy .
```

## License

MIT
