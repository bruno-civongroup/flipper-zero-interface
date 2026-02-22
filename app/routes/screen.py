"""
WebSocket endpoint for live Flipper Zero screen mirroring.

Uses the Flipper's Protobuf RPC protocol. When screen mirroring starts,
the serial connection switches from CLI mode to RPC mode. When stopped,
the connection is restored by reconnecting to CLI mode.

While mirroring is active, other serial commands (terminal, scans) are
blocked. The UI should communicate this to the user.

Protocol:
  1. Send "start_rpc_session\r" to enter binary protobuf mode
  2. Send StartScreenStreamRequest (Main message, field 20)
  3. Receive ScreenFrame messages (Main message, field 22) continuously
  4. Send StopScreenStreamRequest (field 21) when done
  5. Close and reopen serial to restore CLI mode
"""

import asyncio
import base64
import io
import time

import serial as pyserial
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.serial_manager import flipper

router = APIRouter(tags=["screen"])

# ── Protobuf field numbers (from flipper.proto / gui.proto) ──
FIELD_COMMAND_ID = 1
FIELD_COMMAND_STATUS = 2
FIELD_HAS_NEXT = 3
FIELD_GUI_START_SCREEN = 20
FIELD_GUI_STOP_SCREEN = 21
FIELD_GUI_SCREEN_FRAME = 22
FIELD_FRAME_DATA = 1


def _encode_varint(value: int) -> bytes:
    """Encode an integer as a protobuf varint."""
    parts = []
    while value > 0x7F:
        parts.append((value & 0x7F) | 0x80)
        value >>= 7
    parts.append(value & 0x7F)
    return bytes(parts)


def _decode_varint(data: bytes, offset: int = 0) -> tuple[int, int]:
    """Decode a varint from bytes, returns (value, bytes_consumed)."""
    result = 0
    shift = 0
    pos = offset
    while pos < len(data):
        byte = data[pos]
        result |= (byte & 0x7F) << shift
        pos += 1
        if not (byte & 0x80):
            return result, pos - offset
        shift += 7
    raise ValueError("Incomplete varint")


def _encode_tag(field_number: int, wire_type: int) -> bytes:
    return _encode_varint((field_number << 3) | wire_type)


def _build_rpc_message(command_id: int, content_field: int) -> bytes:
    """Build a Main message with an empty sub-message at the given field."""
    inner = _encode_tag(FIELD_COMMAND_ID, 0) + _encode_varint(command_id)
    inner += _encode_tag(content_field, 2) + _encode_varint(0)
    return _encode_varint(len(inner)) + inner


def _parse_screen_frame(data: bytes) -> bytes | None:
    """Parse a Main message and extract screen frame bytes, or None."""
    try:
        offset = 0
        while offset < len(data):
            tag_val, consumed = _decode_varint(data, offset)
            offset += consumed
            field_num = tag_val >> 3
            wire_type = tag_val & 0x07

            if wire_type == 0:  # varint
                _, consumed = _decode_varint(data, offset)
                offset += consumed
            elif wire_type == 2:  # length-delimited
                length, consumed = _decode_varint(data, offset)
                offset += consumed
                payload = data[offset:offset + length]
                offset += length
                if field_num == FIELD_GUI_SCREEN_FRAME:
                    return _extract_bytes_field(payload, FIELD_FRAME_DATA)
            elif wire_type == 5:
                offset += 4
            elif wire_type == 1:
                offset += 8
        return None
    except Exception:
        return None


def _extract_bytes_field(data: bytes, target_field: int) -> bytes | None:
    """Extract a bytes field from a protobuf submessage."""
    offset = 0
    while offset < len(data):
        tag_val, consumed = _decode_varint(data, offset)
        offset += consumed
        field_num = tag_val >> 3
        wire_type = tag_val & 0x07

        if wire_type == 0:
            _, consumed = _decode_varint(data, offset)
            offset += consumed
        elif wire_type == 2:
            length, consumed = _decode_varint(data, offset)
            offset += consumed
            payload = data[offset:offset + length]
            offset += length
            if field_num == target_field:
                return payload
        elif wire_type == 5:
            offset += 4
        elif wire_type == 1:
            offset += 8
    return None


def frame_to_png_base64(frame_data: bytes) -> str:
    """
    Convert Flipper's 1-bit page-based frame data to a PNG image (base64).

    128x64 pixels: 8 pages x 128 columns, each byte = 8 vertical pixels (LSB = top).
    """
    from PIL import Image

    img = Image.new("1", (128, 64), 0)
    pixels = img.load()

    for page in range(8):
        for col in range(128):
            byte_idx = page * 128 + col
            if byte_idx >= len(frame_data):
                break
            byte = frame_data[byte_idx]
            for bit in range(8):
                y = page * 8 + bit
                if y < 64 and (byte >> bit) & 1:
                    pixels[col, y] = 1

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _read_varint_from_port(port: pyserial.Serial) -> int:
    """Read a varint from the serial port, one byte at a time."""
    result = 0
    shift = 0
    while True:
        byte = port.read(1)
        if not byte:
            raise TimeoutError("Timeout reading varint from serial")
        b = byte[0]
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result
        shift += 7


@router.websocket("/ws/screen")
async def screen_mirror_websocket(ws: WebSocket):
    """
    WebSocket for live screen mirroring.

    Client sends {"action": "start"} to begin streaming.
    While streaming, the Flipper is in RPC mode and CLI is unavailable.
    Client sends {"action": "stop"} to restore CLI mode.
    """
    await ws.accept()

    streaming = False
    stream_task = None
    command_id = 0

    async def enter_rpc_mode():
        """Switch the Flipper's serial from CLI to RPC mode."""
        async with flipper._lock:
            port = flipper._port
            # Flush
            port.read(port.in_waiting or 0)
            # Enter RPC session (note: \r only, not \r\n)
            port.write(b"start_rpc_session\r")
            await asyncio.sleep(0.5)
            # Read and discard the response/echo
            port.read(port.in_waiting or 1)

    async def exit_rpc_mode():
        """Restore CLI mode by closing and reopening the serial connection."""
        port_name = flipper._port.port
        # Close current connection (bypassing the lock since we hold context)
        if flipper._port and flipper._port.is_open:
            flipper._port.close()

        # Reopen
        flipper._port = await asyncio.to_thread(
            pyserial.Serial,
            port_name,
            flipper.BAUD_RATE,
            timeout=flipper.READ_TIMEOUT,
        )
        # Sync to prompt
        flipper._port.write(b"\r\n")
        await asyncio.sleep(0.3)
        flipper._port.read(flipper._port.in_waiting or 1)

    async def send_rpc(content_field: int):
        nonlocal command_id
        command_id += 1
        msg = _build_rpc_message(command_id, content_field)
        flipper._port.write(msg)

    async def read_rpc_frame() -> bytes | None:
        """Read one protobuf message from serial and extract frame data."""
        try:
            port = flipper._port
            length = await asyncio.to_thread(_read_varint_from_port, port)
            if length <= 0 or length > 8192:
                return None
            data = await asyncio.to_thread(port.read, length)
            if len(data) < length:
                return None
            return _parse_screen_frame(data)
        except Exception:
            return None

    async def stream_frames():
        nonlocal streaming
        frame_times = []

        while streaming:
            try:
                t0 = time.monotonic()
                frame_data = await read_rpc_frame()
                t1 = time.monotonic()

                if frame_data and len(frame_data) >= 1024:
                    png_b64 = frame_to_png_base64(frame_data)

                    frame_times.append(t1 - t0)
                    if len(frame_times) > 10:
                        frame_times.pop(0)
                    avg_time = sum(frame_times) / len(frame_times)
                    fps = 1.0 / avg_time if avg_time > 0 else 0

                    await ws.send_json({
                        "type": "frame",
                        "data": png_b64,
                        "fps": round(fps, 1),
                    })
                # None means non-frame message or short data, just continue

            except WebSocketDisconnect:
                streaming = False
                break
            except Exception as e:
                try:
                    await ws.send_json({"type": "error", "message": str(e)})
                except Exception:
                    streaming = False
                    break
                await asyncio.sleep(0.5)

    try:
        while True:
            data = await ws.receive_json()
            action = data.get("action")

            if action == "start" and not streaming:
                if not flipper.connected:
                    await ws.send_json({"type": "error", "message": "Flipper not connected"})
                    continue

                try:
                    await enter_rpc_mode()
                    await send_rpc(FIELD_GUI_START_SCREEN)
                    streaming = True
                    stream_task = asyncio.create_task(stream_frames())
                    await ws.send_json({"type": "status", "streaming": True})
                except Exception as e:
                    await ws.send_json({"type": "error", "message": f"Failed to start: {e}"})
                    try:
                        await exit_rpc_mode()
                    except Exception:
                        pass

            elif action == "stop" and streaming:
                streaming = False
                if stream_task:
                    stream_task.cancel()
                    try:
                        await stream_task
                    except asyncio.CancelledError:
                        pass
                    stream_task = None

                try:
                    await send_rpc(FIELD_GUI_STOP_SCREEN)
                    await asyncio.sleep(0.2)
                except Exception:
                    pass

                try:
                    await exit_rpc_mode()
                except Exception as e:
                    await ws.send_json({"type": "error", "message": f"Failed to restore CLI: {e}"})

                await ws.send_json({"type": "status", "streaming": False})

    except WebSocketDisconnect:
        pass
    finally:
        streaming = False
        if stream_task:
            stream_task.cancel()
            try:
                await stream_task
            except asyncio.CancelledError:
                pass

        # Always try to restore CLI mode on disconnect
        try:
            if flipper.connected:
                await exit_rpc_mode()
        except Exception:
            pass
