"""WebSocket endpoint for live Flipper Zero monitoring."""

import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.serial_manager import flipper

router = APIRouter(tags=["monitor"])


@router.websocket("/ws/monitor")
async def monitor_websocket(ws: WebSocket):
    """
    WebSocket for real-time monitoring.

    Periodically polls Flipper for device info and streams it to the client.
    Client can also send commands through the WebSocket.
    """
    await ws.accept()

    async def poll_status():
        """Background task that sends periodic status updates."""
        while True:
            try:
                if flipper.connected:
                    # Get device info
                    info = await flipper.send_command("device_info", timeout=3.0)
                    await ws.send_json({
                        "type": "status",
                        "connected": True,
                        "info": info,
                    })
                else:
                    await ws.send_json({
                        "type": "status",
                        "connected": False,
                        "info": None,
                    })
            except Exception as e:
                await ws.send_json({"type": "error", "message": str(e)})
            await asyncio.sleep(2.0)

    poll_task = asyncio.create_task(poll_status())

    try:
        while True:
            data = await ws.receive_json()

            if data.get("type") == "command" and flipper.connected:
                try:
                    response = await flipper.send_command(
                        data["command"],
                        timeout=data.get("timeout", 5.0),
                    )
                    await ws.send_json({
                        "type": "response",
                        "command": data["command"],
                        "response": response,
                    })
                except Exception as e:
                    await ws.send_json({
                        "type": "error",
                        "command": data.get("command"),
                        "message": str(e),
                    })

    except WebSocketDisconnect:
        pass
    finally:
        poll_task.cancel()
