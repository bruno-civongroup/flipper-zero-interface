"""Remote control endpoints — simulate D-pad / button presses on Flipper."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.serial_manager import flipper

router = APIRouter(prefix="/api/input", tags=["input"])

VALID_KEYS = {"up", "down", "left", "right", "ok", "back"}
VALID_TYPES = {"short", "long"}


class InputRequest(BaseModel):
    key: str
    type: str = "short"


@router.post("/send")
async def send_input(req: InputRequest):
    """Simulate a button press on the Flipper Zero."""
    if not flipper.connected:
        raise HTTPException(status_code=503, detail="Flipper not connected")

    key = req.key.lower()
    press_type = req.type.lower()

    if key not in VALID_KEYS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid key '{key}'. Valid: {', '.join(sorted(VALID_KEYS))}",
        )
    if press_type not in VALID_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid type '{press_type}'. Valid: {', '.join(sorted(VALID_TYPES))}",
        )

    try:
        result = await flipper.send_command(f"input send {key} {press_type}")
        return {"key": key, "type": press_type, "result": result}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
