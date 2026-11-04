# Flipper Zero Web Interface

Browser-based control panel for Flipper Zero over USB. Uses the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) to talk directly to the Flipper — no backend, no drivers, no install. Just open the page in Chrome or Edge and connect.

**Live:** [projects.brunomalnovic.com/flipper](https://projects.brunomalnovic.com/flipper)

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
flipper/
  index.html                 # Single-page app
  style.css                  # Dark theme UI
  js/
    app.js                   # Main application logic
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

No build step. Open `flipper/index.html` directly or serve with any static server:

```bash
cd flipper && npx serve .
```

## Deployment

Hosted on Cloudflare Pages:

> ⚠️ `deploy .` uploads the whole dir; Pages ignores `.gitignore`/`.assetsignore`. Confirm no `.env`/keys/secrets live here before deploying. Keep static-only.

```bash
npx wrangler pages deploy .
```

## License

[MIT](LICENSE)

## Deploy

    bash deploy.sh            # stage, gate, deploy to production, verify
    bash deploy.sh --dry-run  # stage and gate only, print the manifest

**Never run `wrangler pages deploy .` here.** Cloudflare Pages uploads the
entire directory and honors neither `.gitignore` nor `.assetsignore`, so a bare
`deploy .` publishes every doc and note in this repo to the public web. A
2026-11-04 audit found `README.md`, `flipper/README.md` and `LICENSE` publicly served on this site.

`deploy.sh` copies the repo into a staging dir minus everything that is not a
web asset, aborts if anything unexpected survives (allowlist by file type, so a
**new doc is excluded by default** rather than shipping because nobody updated a
denylist), deploys the staging dir, then probes the live site to confirm nothing
leaked. If the gate rejects a file the site genuinely serves, widen the
allowlist in `deploy.sh` — don't bypass the script.

Docs and notes are safe to keep in this repo; they simply never ship.

Removing a file from the deployment is **not** enough on its own: individual
Cloudflare POPs kept serving cached copies (`cf-cache-status: HIT`,
`s-maxage=604800`) that no purge method evicted. A WAF rule on the `brunomalnovic.com` zone,
*"Block docs/dotfiles at the edge"*, blocks `*.md`, `*.map`, `/.git*`,
`/.env*` and similar **before** cache — so those paths return 403 here by
design. Full detail: `D:/Projects/CLAUDE.md` → "Cloudflare Pages deploy safety
(2026-11-04 audit)".
