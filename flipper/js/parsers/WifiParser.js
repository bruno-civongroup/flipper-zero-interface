/**
 * WiFi scan result parsers — translates from wifi.py parse_ap_list() / parse_station_list().
 */

/**
 * Parse Marauder AP list output.
 *
 * Handles multiple formats:
 *   Format A:  [0][CH:3] 7a:c9:e3:c7:5b:05 -80 MyNetwork
 *   Format A2: [0][CH:4] PYS2Roars -54
 *   Format B:  0) MyNetwork -54 3 7a:c9:e3:c7:5b:05 WPA2
 */
export function parseApList(raw) {
  const aps = [];

  // Only parse lines after "list -a" command output
  let inList = false;
  let linesToParse = [];
  for (const line of raw.split('\n')) {
    const stripped = line.trim();
    if (stripped.includes('list -a')) {
      inList = true;
      continue;
    }
    if (inList) linesToParse.push(stripped);
  }

  if (linesToParse.length === 0) {
    linesToParse = raw.split('\n').map(l => l.trim());
  }

  for (const line of linesToParse) {
    if (!line || line.startsWith('APs') || line.startsWith('---')) continue;
    if (line.startsWith('#') || line.startsWith('>') || line.includes('selected')) continue;
    if (line.includes('Script') || line.includes('Running') || line.includes('press CTRL')) continue;
    if (line.includes('Stopping') || line.includes('Beacon:') || line.includes('tran/recv')) continue;

    // Format A: "[idx][CH:ch] BSSID RSSI SSID"
    let m = line.match(/\[(\d+)\]\[CH:(\d+)\]\s+([0-9A-Fa-f:]{17})\s+(-?\d+)\s*(.*)/);
    if (m) {
      aps.push({
        index: parseInt(m[1]), channel: parseInt(m[2]), bssid: m[3],
        rssi: parseInt(m[4]), ssid: m[5].trim() || '(hidden)', encryption: 'Unknown',
      });
      continue;
    }

    // Format A2: "[idx][CH:ch] SSID RSSI"
    m = line.match(/\[(\d+)\]\[CH:(\d+)\]\s+(.+?)\s+(-?\d+)\s*$/);
    if (m) {
      aps.push({
        index: parseInt(m[1]), channel: parseInt(m[2]), bssid: '',
        rssi: parseInt(m[4]), ssid: m[3].trim() || '(hidden)', encryption: 'Unknown',
      });
      continue;
    }

    // Format B: "idx) SSID RSSI CH BSSID Enc"
    m = line.match(/(\d+)\)\s+(.+?)\s+(-?\d+)\s+(\d+)\s+([0-9A-Fa-f:]{17})\s*(\S*)/);
    if (m) {
      aps.push({
        index: parseInt(m[1]), ssid: m[2].trim(), rssi: parseInt(m[3]),
        channel: parseInt(m[4]), bssid: m[5], encryption: m[6] || 'Unknown',
      });
      continue;
    }

    // Fallback: line with MAC address
    const macMatch = /([0-9A-Fa-f:]{17})/.exec(line);
    if (macMatch) {
      const afterMac = line.split(macMatch[1]).pop();
      const rssiMatch = /(-?\d{2,3})/.exec(afterMac);
      aps.push({
        index: aps.length, bssid: macMatch[1],
        rssi: rssiMatch ? parseInt(rssiMatch[1]) : null,
        channel: null, ssid: '(unknown)', encryption: 'Unknown',
      });
    }
  }
  return aps;
}

/**
 * Parse Marauder station list output.
 */
export function parseStationList(raw) {
  const stations = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const macMatch = /([0-9A-Fa-f:]{17})/.exec(trimmed);
    if (macMatch && !trimmed.startsWith('---')) {
      stations.push({ index: stations.length, mac: macMatch[1], raw: trimmed });
    }
  }
  return stations;
}
