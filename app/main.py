"""FastAPI application for Flipper Zero web interface."""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from app.routes import serial, files, monitor, wifi, subghz, nfcrfid, export, input, ir, screen

app = FastAPI(
    title="Flipper Zero Interface",
    description="Web-based interface for Flipper Zero",
    version="0.1.0",
)

# Register API routes
app.include_router(serial.router)
app.include_router(files.router)
app.include_router(monitor.router)
app.include_router(wifi.router)
app.include_router(subghz.router)
app.include_router(nfcrfid.router)
app.include_router(export.router)
app.include_router(input.router)
app.include_router(ir.router)
app.include_router(screen.router)

# Serve static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(static_dir / "index.html"))
