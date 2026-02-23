"""File management endpoints for Flipper Zero SD card."""

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from app import file_manager

router = APIRouter(prefix="/api/files", tags=["files"])


class PathRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    old_path: str
    new_path: str


@router.get("/list")
async def list_dir(path: str = "/ext"):
    """List files and directories at the given path."""
    try:
        entries = await file_manager.list_directory(path)
        return {"path": path, "entries": entries}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/read")
async def read_file(path: str):
    """Read a file from the Flipper."""
    try:
        content = await file_manager.read_file(path)
        return {"path": path, "content": content}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/stat")
async def stat_file(path: str):
    """Get file/directory info."""
    try:
        info = await file_manager.stat(path)
        return {"path": path, "info": info}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload")
async def upload_file(path: str, file: UploadFile = File(...)):
    """Upload a file to the Flipper."""
    try:
        content = await file.read()
        await file_manager.write_file(path, content)
        return {"path": path, "size": len(content), "status": "uploaded"}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/mkdir")
async def make_directory(req: PathRequest):
    """Create a directory on the Flipper."""
    try:
        result = await file_manager.mkdir(req.path)
        return {"path": req.path, "result": result}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rename")
async def rename_path(req: RenameRequest):
    """Rename or move a file/directory on the Flipper."""
    try:
        result = await file_manager.rename(req.old_path, req.new_path)
        return {"old_path": req.old_path, "new_path": req.new_path, "result": result}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/download")
async def download_file(path: str):
    """Download a file from the Flipper as a binary attachment."""
    try:
        content = await file_manager.read_file(path)
        filename = path.rsplit("/", 1)[-1]
        return Response(
            content=content.encode("utf-8", errors="surrogateescape"),
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/remove")
async def remove_path(path: str):
    """Delete a file or directory on the Flipper."""
    try:
        result = await file_manager.remove(path)
        return {"path": path, "result": result}
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
