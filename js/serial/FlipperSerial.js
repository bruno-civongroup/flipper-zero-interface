/**
 * Web Serial interface for Flipper Zero.
 *
 * Replaces serial_manager.py — talks directly to the Flipper's USB CDC
 * port at 230400 baud using the browser's Web Serial API.
 *
 * The Flipper CLI sends text lines; responses end with ">: " prompt.
 */

import { Mutex } from './Mutex.js';

const BAUD_RATE = 230400;
const PROMPT = new Uint8Array([0x3E, 0x3A, 0x20]); // ">: "
const FLIPPER_FILTERS = [{ usbVendorId: 0x0483, usbProductId: 0x5740 }];

export class FlipperSerial {
  constructor() {
    this._port = null;
    this._reader = null;
    this._readBuffer = new Uint8Array(0);
    this._readLoopRunning = false;
    this._lock = new Mutex();
    this._onDisconnect = null;
  }

  get connected() {
    return this._port !== null && this._readLoopRunning;
  }

  /** Get underlying port for RPC mode (screen mirror). */
  get port() {
    return this._port;
  }

  /**
   * Connect to a Flipper Zero via Web Serial.
   * Shows the browser's serial picker dialog.
   */
  async connect() {
    if (this.connected) return;

    // Try previously granted ports first
    const ports = await navigator.serial.getPorts();
    let port = ports.find(p => {
      const info = p.getInfo();
      return info.usbVendorId === 0x0483 && info.usbProductId === 0x5740;
    });

    if (!port) {
      port = await navigator.serial.requestPort({ filters: FLIPPER_FILTERS });
    }

    await port.open({ baudRate: BAUD_RATE });
    this._port = port;

    // Start background read loop
    this._startReadLoop();

    // Clear any partial input, sync to prompt
    await this._write(new Uint8Array([0x0D, 0x0A])); // \r\n
    await this._sleep(300);
    this._flushBuffer();

    // Listen for disconnect
    port.addEventListener('disconnect', () => {
      this._readLoopRunning = false;
      this._port = null;
      if (this._onDisconnect) this._onDisconnect();
    });
  }

  /**
   * Disconnect from the Flipper.
   */
  async disconnect() {
    await this._stopReadLoop();
    if (this._port) {
      try { await this._port.close(); } catch {}
      this._port = null;
    }
  }

  /**
   * Register a callback for unexpected disconnection.
   */
  onDisconnect(fn) {
    this._onDisconnect = fn;
  }

  /**
   * Send a CLI command and return the response text.
   * Equivalent to serial_manager.py send_command().
   */
  async sendCommand(command, timeout = 5000) {
    if (!this.connected) throw new Error('Not connected to Flipper Zero');

    await this._lock.acquire();
    try {
      this._flushBuffer();
      await this._write(this._encode(`${command}\r\n`));
      const raw = await this._waitForPrompt(timeout);
      return this._cleanResponse(raw, command);
    } finally {
      this._lock.release();
    }
  }

  /**
   * Run a streaming command (e.g. subghz rx, ir rx) for a duration,
   * then send Ctrl+C and collect remaining output.
   */
  async sendStreamingCommand(command, durationMs = 10000) {
    if (!this.connected) throw new Error('Not connected to Flipper Zero');

    await this._lock.acquire();
    try {
      this._flushBuffer();
      await this._write(this._encode(`${command}\r\n`));

      // Collect output for the duration
      await this._sleep(durationMs);

      // Send Ctrl+C to stop
      await this._write(new Uint8Array([0x03]));

      // Wait for prompt to return (this accumulates into the same buffer)
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (this._bufferContainsPrompt()) break;
        await this._sleep(50);
      }

      // Read entire accumulated buffer (stream output + post-Ctrl+C output)
      const raw = this._decodeBuffer(this._readBuffer);
      this._flushBuffer();
      return this._cleanStreamingResponse(raw, command);
    } finally {
      this._lock.release();
    }
  }

  /**
   * Run a command inside the NFC sub-CLI.
   * Enters nfc sub-shell, runs command, Ctrl+C, exits back to main CLI.
   */
  async sendNfcCommand(command, durationMs = 10000) {
    if (!this.connected) throw new Error('Not connected to Flipper Zero');

    await this._lock.acquire();
    try {
      this._flushBuffer();

      // Enter NFC sub-CLI
      await this._write(this._encode('nfc\r\n'));
      await this._sleep(1000);
      this._flushBuffer(); // discard banner

      // Send the command
      await this._write(this._encode(`${command}\r\n`));

      // Collect output for duration
      await this._sleep(durationMs);

      const collected = this._decodeBuffer(this._readBuffer);

      // Ctrl+C to stop
      await this._write(new Uint8Array([0x03]));
      await this._sleep(500);
      this._flushBuffer();

      // Exit NFC sub-CLI
      await this._write(this._encode('exit\r\n'));
      await this._sleep(500);

      // Wait for main prompt
      await this._waitForPrompt(3000);
      this._flushBuffer();

      return this._stripAnsi(collected).trim();
    } finally {
      this._lock.release();
    }
  }

  /**
   * Send raw bytes (for protobuf RPC, etc.).
   */
  async sendRaw(data) {
    if (!this._port) throw new Error('Not connected to Flipper Zero');
    const writer = this._port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Write a text file to the Flipper using `storage write` CLI mode.
   * Replaces serial_manager.py write_file().
   */
  async writeFile(path, content) {
    if (!this.connected) throw new Error('Not connected to Flipper Zero');

    await this._lock.acquire();
    try {
      this._flushBuffer();

      // Remove existing file first
      await this._write(this._encode(`storage remove ${path}\r\n`));
      await this._sleep(300);
      this._flushBuffer();

      // Enter write mode
      await this._write(this._encode(`storage write ${path}\r\n`));
      await this._sleep(300);
      this._flushBuffer();

      // Send content in 128-byte chunks
      const encoded = content instanceof Uint8Array ? content : this._encode(content);
      const chunkSize = 128;
      for (let i = 0; i < encoded.length; i += chunkSize) {
        await this._write(encoded.slice(i, i + chunkSize));
        await this._sleep(50);
      }

      // End write mode with Ctrl+C
      await this._sleep(100);
      await this._write(new Uint8Array([0x03]));

      // Wait for prompt
      await this._waitForPrompt(5000);
      this._flushBuffer();
    } finally {
      this._lock.release();
    }
  }

  /**
   * Run a JS script on the Flipper. Higher timeout for scan scripts.
   */
  async runJs(scriptPath, timeout = 30000) {
    return this.sendCommand(`js ${scriptPath}`, timeout);
  }

  /**
   * Stop the read loop and release the reader.
   * Used before entering RPC mode (screen mirror).
   */
  async stopReadLoop() {
    await this._stopReadLoop();
  }

  /**
   * Restart the read loop after exiting RPC mode.
   */
  startReadLoop() {
    this._startReadLoop();
  }

  // ── Internal helpers ──

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
          if (value) {
            this._appendBuffer(value);
          }
        }
      } catch (e) {
        // Reader was cancelled or port disconnected
        if (this._readLoopRunning) {
          // Unexpected error — mark disconnected
          this._readLoopRunning = false;
          if (this._onDisconnect) this._onDisconnect();
        }
      } finally {
        if (this._reader) {
          try { this._reader.releaseLock(); } catch {}
          this._reader = null;
        }
      }
    }
  }

  async _write(data) {
    const writer = this._port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
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

  _bufferContainsPrompt() {
    if (this._readBuffer.length < PROMPT.length) return false;
    for (let i = this._readBuffer.length - PROMPT.length; i >= 0; i--) {
      if (this._readBuffer[i] === PROMPT[0] &&
          this._readBuffer[i + 1] === PROMPT[1] &&
          this._readBuffer[i + 2] === PROMPT[2]) {
        return true;
      }
    }
    return false;
  }

  async _waitForPrompt(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._bufferContainsPrompt()) {
        const raw = this._decodeBuffer(this._readBuffer);
        this._flushBuffer();
        return raw;
      }
      await this._sleep(50);
    }
    // Timeout — return whatever we have
    const raw = this._decodeBuffer(this._readBuffer);
    this._flushBuffer();
    return raw;
  }

  _cleanResponse(raw, command) {
    const lines = raw.split('\r\n');
    const output = [];
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped === command || stripped.endsWith('>:')) continue;
      output.push(line);
    }
    return output.join('\n').trim();
  }

  _cleanStreamingResponse(raw, command) {
    let text = this._stripAnsi(raw);
    const lines = text.split('\r\n');
    const output = [];
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped === command || stripped.endsWith('>:')) continue;
      if (stripped) output.push(line);
    }
    return output.join('\n').trim();
  }

  _stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  _encode(str) {
    return new TextEncoder().encode(str);
  }

  _decodeBuffer(buf) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
