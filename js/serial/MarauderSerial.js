/**
 * Web Serial interface for ESP32 Marauder WiFi Dev Board.
 * Replaces marauder.py — talks directly via Web Serial at 115200 baud.
 *
 * Supports direct USB mode (ESP32 connected to PC).
 * JS Bridge mode (through Flipper UART) is handled by FlipperSerial.writeFile + runJs.
 */

import { Mutex } from './Mutex.js';

// Known ESP32 USB-UART chip VID:PIDs
const ESP32_FILTERS = [
  { usbVendorId: 0x10C4 }, // Silicon Labs CP2102/CP2104
  { usbVendorId: 0x1A86 }, // QinHeng CH340/CH341
  { usbVendorId: 0x0403 }, // FTDI FT232
  { usbVendorId: 0x303A }, // Espressif native USB
];

export class MarauderSerial {
  constructor() {
    this._port = null;
    this._lock = new Mutex();
    this._scanning = false;
    this._reader = null;
    this._readBuffer = new Uint8Array(0);
    this._readLoopRunning = false;
  }

  get connected() {
    return this._port !== null && this._readLoopRunning;
  }

  get scanning() {
    return this._scanning;
  }

  /**
   * Connect to ESP32 via Web Serial picker.
   */
  async connect() {
    if (this.connected) return;

    const port = await navigator.serial.requestPort({ filters: ESP32_FILTERS });
    await port.open({ baudRate: 115200 });
    this._port = port;

    this._startReadLoop();

    // Clear startup garbage
    await this._sleep(500);
    this._flushBuffer();
  }

  async disconnect() {
    this._scanning = false;
    await this._stopReadLoop();
    if (this._port) {
      try { await this._port.close(); } catch {}
      this._port = null;
    }
  }

  /**
   * Send a command and collect output for readTimeMs.
   */
  async sendCommand(command, readTimeMs = 2000) {
    if (!this.connected) throw new Error('Not connected to Marauder');

    await this._lock.acquire();
    try {
      this._flushBuffer();
      const writer = this._port.writable.getWriter();
      await writer.write(new TextEncoder().encode(`${command}\n`));
      writer.releaseLock();

      await this._sleep(readTimeMs);

      const raw = new TextDecoder('utf-8', { fatal: false }).decode(this._readBuffer);
      this._flushBuffer();
      return raw.trim();
    } finally {
      this._lock.release();
    }
  }

  /**
   * Start AP scan, wait, stop, get results.
   */
  async scanAps() {
    this._scanning = true;
    await this.sendCommand('stopscan', 500);
    await this.sendCommand('scanap', 500);
    await this._sleep(5000);
    await this.sendCommand('stopscan', 500);
    this._scanning = false;
    return this.sendCommand('list -a', 2000);
  }

  /**
   * Start station scan, wait, stop, get results.
   */
  async scanStations() {
    this._scanning = true;
    await this.sendCommand('stopscan', 500);
    await this.sendCommand('scansta', 500);
    await this._sleep(8000);
    await this.sendCommand('stopscan', 500);
    this._scanning = false;
    return this.sendCommand('list -s', 2000);
  }

  // ── Internal ──

  _startReadLoop() {
    if (this._readLoopRunning) return;
    this._readLoopRunning = true;
    this._readLoopPromise = this._readLoop();
  }

  async _stopReadLoop() {
    this._readLoopRunning = false;
    if (this._reader) {
      try { await this._reader.cancel(); } catch {}
      try { this._reader.releaseLock(); } catch {}
      this._reader = null;
    }
    if (this._readLoopPromise) {
      try { await this._readLoopPromise; } catch {}
    }
  }

  async _readLoop() {
    while (this._readLoopRunning && this._port?.readable) {
      try {
        this._reader = this._port.readable.getReader();
        while (this._readLoopRunning) {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (value) this._appendBuffer(value);
        }
      } catch {
        if (this._readLoopRunning) this._readLoopRunning = false;
      } finally {
        if (this._reader) {
          try { this._reader.releaseLock(); } catch {}
          this._reader = null;
        }
      }
    }
  }

  _appendBuffer(chunk) {
    const newBuf = new Uint8Array(this._readBuffer.length + chunk.length);
    newBuf.set(this._readBuffer);
    newBuf.set(chunk, this._readBuffer.length);
    this._readBuffer = newBuf;
  }

  _flushBuffer() {
    this._readBuffer = new Uint8Array(0);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
