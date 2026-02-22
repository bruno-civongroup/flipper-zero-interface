"""WebSocket endpoint for live Flipper Zero screen mirroring."""

import asyncio
import base64
import io
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.serial_manager import flipper

router = APIRouter(tags=["screen"])


def frame_to_png_base64(frame_data: bytes) -> str:
    """
    Convert Flipper's 1-bit page-based frame data to a PNG image (base64).

    The Flipper LCD is 128x64 pixels. Data format:
    - 8 pages (each page = 8 pixel rows)
    - Each page has 128 bytes (one per column)
    - Each byte: bit 0 = top pixel of that 8-pixel column, bit 7 = bottom
    - Pixel set = orange/white, pixel clear = black

    Returns a base64-encoded PNG string.
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


@router.websocket("/ws/screen")
async def screen_mirror_websocket(ws: WebSocket):
    """
    WebSocket for live screen mirroring.

    Client sends {"action": "start"} to begin streaming frames,
    {"action": "stop"} to pause. Server sends frames as:
    {"type": "frame", "data": "<base64 PNG>", "fps": 4.2}
    """
    await ws.accept()

    streaming = False
    stream_task = None

    async def stream_frames():
        nonlocal streaming
        frame_times = []

        while streaming:
            try:
                if not flipper.connected:
                    await ws.send_json({"type": "error", "message": "Flipper disconnected"})
                    streaming = False
                    break

                t0 = time.monotonic()
                frame_data = await flipper.capture_screen_frame()
                t1 = time.monotonic()

                if not frame_data or len(frame_data) < 1024:
                    await ws.send_json({"type": "error", "message": "Failed to capture frame"})
                    await asyncio.sleep(0.5)
                    continue

                png_b64 = frame_to_png_base64(frame_data)

                # Calculate FPS from recent frame times
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

                # Small sleep to give other serial operations a window
                await asyncio.sleep(0.05)

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
                streaming = True
                stream_task = asyncio.create_task(stream_frames())
                await ws.send_json({"type": "status", "streaming": True})

            elif action == "stop" and streaming:
                streaming = False
                if stream_task:
                    stream_task.cancel()
                    try:
                        await stream_task
                    except asyncio.CancelledError:
                        pass
                    stream_task = None
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
