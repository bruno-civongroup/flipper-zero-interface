"""
Manages serial communication with Flipper Zero over USB.

The Flipper exposes a CLI over USB CDC at 230400 baud.
Commands are sent as text lines; responses end with ">: " prompt.
"""

import asyncio
import serial
import serial.tools.list_ports
from typing import Optional


class FlipperSerial:
    BAUD_RATE = 230400
    PROMPT = b">: "
    READ_TIMEOUT = 2.0

    def __init__(self):
        self._port: Optional[serial.Serial] = None
        self._lock = asyncio.Lock()

    @staticmethod
    def find_flipper_port() -> Optional[str]:
        """Auto-detect Flipper Zero by USB VID:PID (0483:5740)."""
        for port in serial.tools.list_ports.comports():
            if port.vid == 0x0483 and port.pid == 0x5740:
                return port.device
        return None

    @staticmethod
    def list_serial_ports() -> list[dict]:
        """List all available serial ports with metadata."""
        return [
            {
                "device": p.device,
                "description": p.description,
                "vid": p.vid,
                "pid": p.pid,
                "is_flipper": p.vid == 0x0483 and p.pid == 0x5740,
            }
            for p in serial.tools.list_ports.comports()
        ]

    @property
    def connected(self) -> bool:
        return self._port is not None and self._port.is_open

    async def connect(self, port: Optional[str] = None) -> str:
        """Connect to Flipper Zero. Auto-detects port if not specified."""
        async with self._lock:
            if self.connected:
                return self._port.port

            device = port or self.find_flipper_port()
            if not device:
                raise ConnectionError(
                    "Flipper Zero not found. Is it plugged in with USB cable?"
                )

            self._port = await asyncio.to_thread(
                serial.Serial,
                device,
                self.BAUD_RATE,
                timeout=self.READ_TIMEOUT,
            )

            # Send a newline to clear any partial input, wait for prompt
            self._port.write(b"\r\n")
            await asyncio.sleep(0.3)
            self._port.read(self._port.in_waiting or 1)

            return device

    async def disconnect(self):
        """Close the serial connection."""
        async with self._lock:
            if self._port and self._port.is_open:
                await asyncio.to_thread(self._port.close)
            self._port = None

    async def send_command(self, command: str, timeout: float = 5.0) -> str:
        """Send a CLI command and return the response text."""
        if not self.connected:
            raise ConnectionError("Not connected to Flipper Zero")

        async with self._lock:
            # Flush input buffer
            self._port.read(self._port.in_waiting or 0)

            # Send command
            self._port.write(f"{command}\r\n".encode())

            # Read response until prompt
            response = b""
            deadline = asyncio.get_event_loop().time() + timeout
            while asyncio.get_event_loop().time() < deadline:
                waiting = self._port.in_waiting
                if waiting:
                    chunk = self._port.read(waiting)
                    response += chunk
                    if self.PROMPT in response:
                        break
                else:
                    await asyncio.sleep(0.05)

            text = response.decode("utf-8", errors="replace")
            # Strip the echoed command and trailing prompt
            lines = text.split("\r\n")
            # Remove first line (echo) and last line (prompt)
            output_lines = []
            for line in lines:
                stripped = line.strip()
                if stripped == command or stripped.endswith(">:"):
                    continue
                output_lines.append(line)
            return "\n".join(output_lines).strip()

    async def send_raw(self, data: bytes):
        """Send raw bytes (for file transfers, etc.)."""
        if not self.connected:
            raise ConnectionError("Not connected to Flipper Zero")
        async with self._lock:
            await asyncio.to_thread(self._port.write, data)

    async def write_file(self, path: str, content: str, timeout: float = 5.0):
        """
        Write a text file to the Flipper using `storage write` CLI mode.

        This bypasses the normal prompt-based send_command flow since
        `storage write` enters an interactive mode that doesn't show
        the prompt until Ctrl+C is sent.
        """
        if not self.connected:
            raise ConnectionError("Not connected to Flipper Zero")

        async with self._lock:
            # Flush buffer
            self._port.read(self._port.in_waiting or 0)

            # Remove existing file first
            self._port.write(f"storage remove {path}\r\n".encode())
            await asyncio.sleep(0.3)
            self._port.read(self._port.in_waiting or 0)

            # Enter write mode
            self._port.write(f"storage write {path}\r\n".encode())
            await asyncio.sleep(0.3)
            self._port.read(self._port.in_waiting or 0)

            # Send content in small chunks to avoid buffer overflow
            encoded = content.encode("utf-8")
            chunk_size = 128
            for i in range(0, len(encoded), chunk_size):
                self._port.write(encoded[i:i + chunk_size])
                await asyncio.sleep(0.05)

            # End write mode with Ctrl+C
            await asyncio.sleep(0.1)
            self._port.write(b"\x03")

            # Wait for prompt to return
            deadline = asyncio.get_event_loop().time() + timeout
            while asyncio.get_event_loop().time() < deadline:
                waiting = self._port.in_waiting
                if waiting:
                    data = self._port.read(waiting)
                    if self.PROMPT in data:
                        break
                await asyncio.sleep(0.05)

    async def send_streaming_command(
        self, command: str, duration: float = 10.0
    ) -> str:
        """
        Run a command that streams output until Ctrl+C (e.g. subghz rx).

        Listens for `duration` seconds, sends Ctrl+C, then collects
        remaining output until the prompt returns.
        """
        if not self.connected:
            raise ConnectionError("Not connected to Flipper Zero")

        async with self._lock:
            # Flush
            self._port.read(self._port.in_waiting or 0)

            # Send command
            self._port.write(f"{command}\r\n".encode())

            # Collect output for the duration
            response = b""
            deadline = asyncio.get_event_loop().time() + duration
            while asyncio.get_event_loop().time() < deadline:
                waiting = self._port.in_waiting
                if waiting:
                    response += self._port.read(waiting)
                await asyncio.sleep(0.1)

            # Send Ctrl+C to stop
            self._port.write(b"\x03")

            # Read remaining output until prompt
            stop_deadline = asyncio.get_event_loop().time() + 3.0
            while asyncio.get_event_loop().time() < stop_deadline:
                waiting = self._port.in_waiting
                if waiting:
                    chunk = self._port.read(waiting)
                    response += chunk
                    if self.PROMPT in response:
                        break
                await asyncio.sleep(0.05)

            text = response.decode("utf-8", errors="replace")
            # Strip ANSI escape codes
            import re
            text = re.sub(r"\x1b\[[0-9;]*m", "", text)
            # Clean up
            lines = text.split("\r\n")
            output_lines = []
            for line in lines:
                stripped = line.strip()
                if stripped == command or stripped.endswith(">:"):
                    continue
                if stripped:
                    output_lines.append(line)
            return "\n".join(output_lines).strip()

    async def send_nfc_command(self, command: str, duration: float = 10.0) -> str:
        """
        Run a command inside the NFC sub-CLI.

        Enters the NFC sub-shell, runs the command, collects output,
        sends Ctrl+C, exits back to main CLI.
        """
        if not self.connected:
            raise ConnectionError("Not connected to Flipper Zero")

        import re as _re

        async with self._lock:
            # Flush
            self._port.read(self._port.in_waiting or 0)

            # Enter NFC sub-CLI
            self._port.write(b"nfc\r\n")
            await asyncio.sleep(1.0)
            self._port.read(self._port.in_waiting or 0)  # discard banner

            # Send the command
            self._port.write(f"{command}\r\n".encode())

            # Collect output for duration
            response = b""
            deadline = asyncio.get_event_loop().time() + duration
            while asyncio.get_event_loop().time() < deadline:
                waiting = self._port.in_waiting
                if waiting:
                    response += self._port.read(waiting)
                await asyncio.sleep(0.1)

            # Ctrl+C to stop any active operation
            self._port.write(b"\x03")
            await asyncio.sleep(0.5)
            self._port.read(self._port.in_waiting or 0)

            # Exit NFC sub-CLI
            self._port.write(b"exit\r\n")
            await asyncio.sleep(0.5)

            # Wait for main prompt
            exit_deadline = asyncio.get_event_loop().time() + 3.0
            while asyncio.get_event_loop().time() < exit_deadline:
                waiting = self._port.in_waiting
                if waiting:
                    chunk = self._port.read(waiting)
                    if self.PROMPT in chunk:
                        break
                await asyncio.sleep(0.05)

            text = response.decode("utf-8", errors="replace")
            text = _re.sub(r"\x1b\[[0-9;]*m", "", text)
            return text.strip()

    async def run_js(self, script_path: str, timeout: float = 30.0) -> str:
        """
        Run a JS script on the Flipper and return its printed output.

        JS scripts can take a long time (scanning waits, etc.) so timeout
        is higher than normal commands.
        """
        return await self.send_command(f"js {script_path}", timeout=timeout)


# Singleton instance
flipper = FlipperSerial()
