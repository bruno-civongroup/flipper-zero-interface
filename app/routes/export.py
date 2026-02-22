"""Export/save scan results."""

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from datetime import datetime
import json

router = APIRouter(prefix="/api/export", tags=["export"])


class ExportRequest(BaseModel):
    scan_type: str  # "wifi_ap", "wifi_sta", "subghz", "nfc", "rfid"
    data: dict
    format: str = "json"  # "json" or "csv"


@router.post("/download")
async def export_download(req: ExportRequest):
    """Generate a downloadable file from scan results."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"flipper_{req.scan_type}_{timestamp}"

    if req.format == "csv":
        content = to_csv(req.scan_type, req.data)
        return Response(
            content=content,
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
        )
    else:
        content = json.dumps(req.data, indent=2)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}.json"'},
        )


def to_csv(scan_type: str, data: dict) -> str:
    """Convert scan data to CSV format."""
    lines = []

    if scan_type == "wifi_ap":
        lines.append("Index,SSID,RSSI,Channel,BSSID,Encryption")
        for ap in data.get("access_points", []):
            lines.append(
                f'{ap.get("index","")},"{ap.get("ssid","")}",'
                f'{ap.get("rssi","")},{ap.get("channel","")},'
                f'{ap.get("bssid","")},{ap.get("encryption","")}'
            )

    elif scan_type == "wifi_sta":
        lines.append("Index,MAC,Details")
        for s in data.get("stations", []):
            lines.append(f'{s.get("index","")},{s.get("mac","")},"{s.get("raw","")}"')

    elif scan_type == "subghz":
        lines.append("Protocol,Bits,Key,TE_us")
        for sig in data.get("signals", []):
            lines.append(
                f'{sig.get("protocol","")},{sig.get("bits","")},'
                f'{sig.get("key","")},{sig.get("te","")}'
            )

    elif scan_type == "nfc":
        lines.append("UID,Type,Protocol,ATQA,SAK")
        for tag in data.get("tags", []):
            lines.append(
                f'{tag.get("uid","")},{tag.get("type","")},{tag.get("protocol","")},'
                f'{tag.get("atqa","")},{tag.get("sak","")}'
            )

    elif scan_type == "rfid":
        lines.append("Protocol,ID,Data,FacilityCode,CardNumber")
        for card in data.get("cards", []):
            lines.append(
                f'{card.get("protocol","")},{card.get("id","")},{card.get("data","")},'
                f'{card.get("facility_code","")},{card.get("card_number","")}'
            )

    return "\n".join(lines)
