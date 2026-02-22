"""Serial connection and command endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.serial_manager import flipper

router = APIRouter(prefix="/api/serial", tags=["serial"])


class ConnectRequest(BaseModel):
    port: str | None = None


class CommandRequest(BaseModel):
    command: str
    timeout: float = 5.0


@router.get("/ports")
async def list_ports():
    """List available serial ports."""
    return {"ports": flipper.list_serial_ports()}


@router.get("/status")
async def connection_status():
    """Check if Flipper is connected."""
    return {"connected": flipper.connected}


@router.post("/connect")
async def connect(req: ConnectRequest = ConnectRequest()):
    """Connect to Flipper Zero. Auto-detects port if not specified."""
    try:
        device = await flipper.connect(req.port)
        return {"connected": True, "port": device}
    except ConnectionError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/disconnect")
async def disconnect():
    """Disconnect from Flipper Zero."""
    await flipper.disconnect()
    return {"connected": False}


@router.post("/command")
async def send_command(req: CommandRequest):
    """Send a CLI command and return the response."""
    try:
        response = await flipper.send_command(req.command, timeout=req.timeout)
        return {"command": req.command, "response": response}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
