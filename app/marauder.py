"""
Marauder serial interface for ESP32 WiFi Dev Board.

Supports two connection modes:
  1. Direct USB: ESP32 Dev Board connected to PC via its own USB-C port
  2. JS Bridge: Commands forwarded through Flipper's UART via a JS script

Marauder commands reference:
  scanap              - Scan for access points
  scansta             - Scan for client stations
  stopscan            - Stop any active scan
  list -a             - List scanned access points
  list -s             - List scanned stations
  sniffbeacon         - Sniff beacon frames
  sniffdeauth         - Sniff deauth frames
  sniffpmkid          - Sniff PMKID frames
  channel <n>         - Set channel
  channel -h          - Hop channels
"""

import asyncio
import serial
import serial.tools.list_ports
from typing import Optional


# Known ESP32 USB-UART chip VID:PIDs
ESP32_VIDS = {
    0x10C4,  # Silicon Labs CP2102/CP2104
    0x1A86,  # QinHeng CH340/CH341
    0x0403,  # FTDI FT232
    0x303A,  # Espressif native USB
}


class MarauderSerial:
    BAUD_RATE = 115200

    def __init__(self):
        self._port: Optional[serial.Serial] = None
        self._lock = asyncio.Lock()
        self._scanning = False

    @staticmethod
    def find_esp32_port() -> Optional[str]:
        """Auto-detect ESP32 Dev Board by known USB-UART VIDs."""
        for port in serial.tools.list_ports.comports():
            # Skip the Flipper itself
            if port.vid == 0x0483 and port.pid == 0x5740:
                continue
            if port.vid in ESP32_VIDS:
                return port.device
        return None

    @staticmethod
    def list_candidate_ports() -> list[dict]:
        """List serial ports that could be the ESP32 board."""
        candidates = []
        for p in serial.tools.list_ports.comports():
            if p.vid == 0x0483 and p.pid == 0x5740:
                continue  # skip Flipper
            candidates.append({
                "device": p.device,
                "description": p.description,
                "vid": p.vid,
                "pid": p.pid,
                "likely_esp32": p.vid in ESP32_VIDS if p.vid else False,
            })
        return candidates

    @property
    def connected(self) -> bool:
        return self._port is not None and self._port.is_open

    @property
    def scanning(self) -> bool:
        return self._scanning

    async def connect(self, port: Optional[str] = None) -> str:
        """Connect to Marauder on the ESP32 Dev Board."""
        async with self._lock:
            if self.connected:
                return self._port.port

            device = port or self.find_esp32_port()
            if not device:
                raise ConnectionError(
                    "ESP32 Dev Board not found. Plug in the WiFi Dev Board's USB-C cable."
                )

            self._port = await asyncio.to_thread(
                serial.Serial,
                device,
                self.BAUD_RATE,
                timeout=1.0,
            )

            # Clear any startup garbage
            await asyncio.sleep(0.5)
            self._port.read(self._port.in_waiting or 0)

            return device

    async def disconnect(self):
        async with self._lock:
            if self._scanning:
                self._scanning = False
            if self._port and self._port.is_open:
                await asyncio.to_thread(self._port.close)
            self._port = None

    async def send_command(self, command: str, read_time: float = 2.0) -> str:
        """Send a Marauder command and collect output for read_time seconds."""
        if not self.connected:
            raise ConnectionError("Not connected to Marauder")

        async with self._lock:
            self._port.read(self._port.in_waiting or 0)
            self._port.write(f"{command}\n".encode())

            response = b""
            deadline = asyncio.get_event_loop().time() + read_time
            while asyncio.get_event_loop().time() < deadline:
                waiting = self._port.in_waiting
                if waiting:
                    response += self._port.read(waiting)
                await asyncio.sleep(0.1)

            return response.decode("utf-8", errors="replace").strip()

    async def scan_aps(self) -> str:
        """Start AP scan, wait for results, return them."""
        self._scanning = True
        # Start the scan
        await self.send_command("stopscan", read_time=0.5)
        await self.send_command("scanap", read_time=0.5)
        # Let it scan for a few seconds
        await asyncio.sleep(5.0)
        # Stop and get results
        await self.send_command("stopscan", read_time=0.5)
        self._scanning = False
        result = await self.send_command("list -a", read_time=2.0)
        return result

    async def scan_stations(self) -> str:
        """Start station scan, wait for results, return them."""
        self._scanning = True
        await self.send_command("stopscan", read_time=0.5)
        await self.send_command("scansta", read_time=0.5)
        await asyncio.sleep(8.0)
        await self.send_command("stopscan", read_time=0.5)
        self._scanning = False
        result = await self.send_command("list -s", read_time=2.0)
        return result

    async def read_stream(self, duration: float = 5.0) -> str:
        """Read streaming output for a given duration (for active scans)."""
        if not self.connected:
            raise ConnectionError("Not connected to Marauder")

        response = b""
        deadline = asyncio.get_event_loop().time() + duration
        while asyncio.get_event_loop().time() < deadline:
            async with self._lock:
                waiting = self._port.in_waiting
                if waiting:
                    response += self._port.read(waiting)
            await asyncio.sleep(0.1)

        return response.decode("utf-8", errors="replace").strip()


# Singleton
marauder = MarauderSerial()
