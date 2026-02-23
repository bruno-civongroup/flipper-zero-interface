/**
 * Screen mirror via Flipper's Protobuf RPC protocol.
 * Replaces routes/screen.py — renders directly to Canvas instead of PNG+WebSocket.
 *
 * Protocol:
 *   1. Send "start_rpc_session\r" to enter binary protobuf mode
 *   2. Send StartScreenStreamRequest (Main message, field 20)
 *   3. Receive ScreenFrame messages (field 22) continuously
 *   4. Send StopScreenStreamRequest (field 21) when done
 *   5. Close and reopen serial to restore CLI mode
 *
 * Frame format: 128x64 pixels, 8 pages x 128 columns, each byte = 8 vertical pixels (LSB = top).
 */

// Protobuf field numbers
const FIELD_COMMAND_ID = 1;
const FIELD_GUI_START_SCREEN = 20;
const FIELD_GUI_STOP_SCREEN = 21;
const FIELD_GUI_SCREEN_FRAME = 22;
const FIELD_FRAME_DATA = 1;

export class ScreenMirror {
  constructor(flipperSerial) {
    this._flipper = flipperSerial;
    this._streaming = false;
    this._commandId = 0;
    this._reader = null;
    this._onFrame = null;
    this._onError = null;
    this._onFps = null;
  }

  get streaming() { return this._streaming; }

  /** Register callbacks */
  onFrame(fn) { this._onFrame = fn; }
  onError(fn) { this._onError = fn; }
  onFps(fn) { this._onFps = fn; }

  /**
   * Start screen mirroring.
   * Stops the normal read loop, enters RPC mode, and begins streaming.
   */
  async start(canvas) {
    if (this._streaming) return;

    const port = this._flipper.port;
    if (!port) throw new Error('Flipper not connected');

    // Stop normal read loop
    await this._flipper.stopReadLoop();

    // Flush port
    try {
      const tempReader = port.readable.getReader();
      // Quick non-blocking read to flush
      const timer = setTimeout(() => tempReader.cancel(), 100);
      try { await tempReader.read(); } catch {}
      clearTimeout(timer);
      tempReader.releaseLock();
    } catch {}

    // Enter RPC session (note: \r only, not \r\n)
    const writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode('start_rpc_session\r'));
    writer.releaseLock();

    await this._sleep(500);

    // Flush the RPC response
    try {
      const tempReader = port.readable.getReader();
      const timer = setTimeout(() => tempReader.cancel(), 200);
      try { await tempReader.read(); } catch {}
      clearTimeout(timer);
      tempReader.releaseLock();
    } catch {}

    // Send StartScreenStreamRequest
    this._commandId++;
    const startMsg = buildRpcMessage(this._commandId, FIELD_GUI_START_SCREEN);
    const writer2 = port.writable.getWriter();
    await writer2.write(startMsg);
    writer2.releaseLock();

    this._streaming = true;

    // Prepare canvas context
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Start reading frames
    this._streamLoop(port, canvas, ctx);
  }

  /**
   * Stop screen mirroring and restore CLI mode.
   */
  async stop() {
    if (!this._streaming) return;
    this._streaming = false;

    const port = this._flipper.port;

    // Cancel the reader
    if (this._reader) {
      try { await this._reader.cancel(); } catch {}
      try { this._reader.releaseLock(); } catch {}
      this._reader = null;
    }

    // Send StopScreenStreamRequest
    try {
      this._commandId++;
      const stopMsg = buildRpcMessage(this._commandId, FIELD_GUI_STOP_SCREEN);
      const writer = port.writable.getWriter();
      await writer.write(stopMsg);
      writer.releaseLock();
      await this._sleep(200);
    } catch {}

    // Restore CLI mode by closing and reopening port
    try {
      const portInfo = { baudRate: 230400 };
      await port.close();
      await port.open(portInfo);
    } catch {}

    // Sync to CLI prompt
    try {
      const writer = port.writable.getWriter();
      await writer.write(new Uint8Array([0x0D, 0x0A])); // \r\n
      writer.releaseLock();
      await this._sleep(300);
      // Flush
      const tempReader = port.readable.getReader();
      const timer = setTimeout(() => tempReader.cancel(), 300);
      try { await tempReader.read(); } catch {}
      clearTimeout(timer);
      tempReader.releaseLock();
    } catch {}

    // Restart normal read loop
    this._flipper.startReadLoop();
  }

  async _streamLoop(port, canvas, ctx) {
    const frameTimes = [];
    let buffer = new Uint8Array(0);

    try {
      this._reader = port.readable.getReader();

      while (this._streaming) {
        const t0 = performance.now();

        // Read data
        const { value, done } = await this._reader.read();
        if (done) break;
        if (!value) continue;

        // Append to buffer
        buffer = concatBuffers(buffer, value);

        // Try to parse a complete protobuf message
        const result = tryParseMessage(buffer);
        if (!result) continue;

        buffer = result.remaining;
        const frameData = result.frameData;

        if (frameData && frameData.length >= 1024) {
          // Render directly to canvas
          this._renderFrame(canvas, ctx, frameData);

          const t1 = performance.now();
          frameTimes.push(t1 - t0);
          if (frameTimes.length > 10) frameTimes.shift();
          const avgTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
          const fps = avgTime > 0 ? 1000 / avgTime : 0;
          if (this._onFps) this._onFps(fps.toFixed(1));
        }
      }
    } catch (e) {
      if (this._streaming && this._onError) {
        this._onError(e.message);
      }
    } finally {
      if (this._reader) {
        try { this._reader.releaseLock(); } catch {}
        this._reader = null;
      }
    }
  }

  /**
   * Render a 1-bit page-based frame to canvas using ImageData.
   * 128x64: 8 pages x 128 cols, each byte = 8 vertical pixels (LSB = top).
   */
  _renderFrame(canvas, ctx, frameData) {
    // Create a 128x64 ImageData
    const imgData = ctx.createImageData(128, 64);
    const pixels = imgData.data;

    for (let page = 0; page < 8; page++) {
      for (let col = 0; col < 128; col++) {
        const byteIdx = page * 128 + col;
        if (byteIdx >= frameData.length) break;
        const byte = frameData[byteIdx];
        for (let bit = 0; bit < 8; bit++) {
          const y = page * 8 + bit;
          if (y >= 64) break;
          const pixelIdx = (y * 128 + col) * 4;
          const on = (byte >> bit) & 1;
          pixels[pixelIdx] = on ? 255 : 0;     // R
          pixels[pixelIdx + 1] = on ? 130 : 0; // G (orange tint for Flipper)
          pixels[pixelIdx + 2] = 0;             // B
          pixels[pixelIdx + 3] = 255;           // A
        }
      }
    }

    // Draw at native 128x64, CSS handles scaling
    canvas.width = 128;
    canvas.height = 64;
    ctx.putImageData(imgData, 0, 0);

    if (this._onFrame) this._onFrame();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Protobuf helpers ──

function encodeVarint(value) {
  const parts = [];
  while (value > 0x7F) {
    parts.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  parts.push(value & 0x7F);
  return new Uint8Array(parts);
}

function decodeVarint(data, offset = 0) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos];
    result |= (byte & 0x7F) << shift;
    pos++;
    if (!(byte & 0x80)) return { value: result, consumed: pos - offset };
    shift += 7;
  }
  return null; // incomplete
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function buildRpcMessage(commandId, contentField) {
  // Build inner: command_id varint + content_field (empty sub-message)
  const parts = [
    encodeTag(FIELD_COMMAND_ID, 0), encodeVarint(commandId),
    encodeTag(contentField, 2), encodeVarint(0),
  ];
  const inner = concatAll(parts);
  return concatBuffers(encodeVarint(inner.length), inner);
}

function tryParseMessage(buffer) {
  if (buffer.length === 0) return null;

  // Read message length varint
  const lenResult = decodeVarint(buffer, 0);
  if (!lenResult) return null;

  const msgLen = lenResult.value;
  const headerLen = lenResult.consumed;

  if (msgLen <= 0 || msgLen > 8192) {
    // Skip this byte and try again
    return { frameData: null, remaining: buffer.slice(1) };
  }

  if (buffer.length < headerLen + msgLen) return null; // incomplete

  const msgData = buffer.slice(headerLen, headerLen + msgLen);
  const remaining = buffer.slice(headerLen + msgLen);

  const frameData = parseScreenFrame(msgData);
  return { frameData, remaining };
}

function parseScreenFrame(data) {
  try {
    let offset = 0;
    while (offset < data.length) {
      const tagResult = decodeVarint(data, offset);
      if (!tagResult) return null;
      offset += tagResult.consumed;
      const fieldNum = tagResult.value >> 3;
      const wireType = tagResult.value & 0x07;

      if (wireType === 0) { // varint
        const vr = decodeVarint(data, offset);
        if (!vr) return null;
        offset += vr.consumed;
      } else if (wireType === 2) { // length-delimited
        const lr = decodeVarint(data, offset);
        if (!lr) return null;
        offset += lr.consumed;
        const payload = data.slice(offset, offset + lr.value);
        offset += lr.value;
        if (fieldNum === FIELD_GUI_SCREEN_FRAME) {
          return extractBytesField(payload, FIELD_FRAME_DATA);
        }
      } else if (wireType === 5) {
        offset += 4;
      } else if (wireType === 1) {
        offset += 8;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function extractBytesField(data, targetField) {
  let offset = 0;
  while (offset < data.length) {
    const tagResult = decodeVarint(data, offset);
    if (!tagResult) return null;
    offset += tagResult.consumed;
    const fieldNum = tagResult.value >> 3;
    const wireType = tagResult.value & 0x07;

    if (wireType === 0) {
      const vr = decodeVarint(data, offset);
      if (!vr) return null;
      offset += vr.consumed;
    } else if (wireType === 2) {
      const lr = decodeVarint(data, offset);
      if (!lr) return null;
      offset += lr.consumed;
      const payload = data.slice(offset, offset + lr.value);
      offset += lr.value;
      if (fieldNum === targetField) return payload;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    }
  }
  return null;
}

function concatBuffers(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function concatAll(arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
