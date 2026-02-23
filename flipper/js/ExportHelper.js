/**
 * Client-side export — generates CSV/JSON and triggers download.
 * Replaces export.py backend endpoint.
 */

export function downloadJSON(scanType, data) {
  const content = JSON.stringify(data, null, 2);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  triggerDownload(content, `flipper_${scanType}_${ts}.json`, 'application/json');
}

export function downloadCSV(scanType, data) {
  const content = toCSV(scanType, data);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  triggerDownload(content, `flipper_${scanType}_${ts}.csv`, 'text/csv');
}

function triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCSV(scanType, data) {
  const lines = [];

  if (scanType === 'wifi_ap') {
    lines.push('Index,SSID,RSSI,Channel,BSSID,Encryption');
    for (const ap of data.access_points || []) {
      lines.push(`${ap.index ?? ''},"${ap.ssid ?? ''}",${ap.rssi ?? ''},${ap.channel ?? ''},${ap.bssid ?? ''},${ap.encryption ?? ''}`);
    }
  } else if (scanType === 'wifi_sta') {
    lines.push('Index,MAC,Details');
    for (const s of data.stations || []) {
      lines.push(`${s.index ?? ''},${s.mac ?? ''},"${s.raw ?? ''}"`);
    }
  } else if (scanType === 'subghz') {
    lines.push('Protocol,Bits,Key,TE_us');
    for (const sig of data.signals || []) {
      lines.push(`${sig.protocol ?? ''},${sig.bits ?? ''},${sig.key ?? ''},${sig.te ?? ''}`);
    }
  } else if (scanType === 'nfc') {
    lines.push('UID,Type,Protocol,ATQA,SAK');
    for (const tag of data.tags || []) {
      lines.push(`${tag.uid ?? ''},${tag.type ?? ''},${tag.protocol ?? ''},${tag.atqa ?? ''},${tag.sak ?? ''}`);
    }
  } else if (scanType === 'rfid') {
    lines.push('Protocol,ID,Data,FacilityCode,CardNumber');
    for (const card of data.cards || []) {
      lines.push(`${card.protocol ?? ''},${card.id ?? ''},${card.data ?? ''},${card.facility_code ?? ''},${card.card_number ?? ''}`);
    }
  }

  return lines.join('\n');
}
