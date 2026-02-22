"""
File management for Flipper Zero's SD card via CLI commands.

Uses the `storage` CLI command set:
  storage list <path>   - list directory
  storage stat <path>   - file/dir info
  storage read <path>   - read file contents
  storage write <path>  - write file (followed by data)
  storage mkdir <path>  - create directory
  storage remove <path> - delete file/dir
"""

from app.serial_manager import flipper


async def list_directory(path: str = "/ext") -> list[dict]:
    """List files and directories at the given path."""
    raw = await flipper.send_command(f"storage list {path}")
    entries = []
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        if line.startswith("[D]"):
            name = line[3:].strip()
            entries.append({"name": name, "type": "directory", "size": None})
        elif line.startswith("[F]"):
            # Format: [F] filename 1234b
            parts = line[3:].strip().rsplit(" ", 1)
            name = parts[0].strip()
            size = parts[1].rstrip("b") if len(parts) > 1 else None
            entries.append({
                "name": name,
                "type": "file",
                "size": int(size) if size and size.isdigit() else None,
            })
    return entries


async def read_file(path: str) -> str:
    """Read a file's contents from the Flipper."""
    return await flipper.send_command(f"storage read {path}", timeout=10.0)


async def write_file(path: str, content: bytes):
    """Write content to a file on the Flipper."""
    # Use storage write_chunk for binary safety
    await flipper.send_command(f"storage remove {path}")
    await flipper.send_command(f"storage write {path}")
    await flipper.send_raw(content)
    await flipper.send_raw(b"\x03")  # Ctrl+C to end write mode


async def mkdir(path: str) -> str:
    """Create a directory on the Flipper."""
    return await flipper.send_command(f"storage mkdir {path}")


async def remove(path: str) -> str:
    """Delete a file or directory on the Flipper."""
    return await flipper.send_command(f"storage remove {path}")


async def stat(path: str) -> str:
    """Get file/directory info."""
    return await flipper.send_command(f"storage stat {path}")
