/**
 * NFC and RFID output parsers — translates from nfcrfid.py.
 */

/**
 * Parse NFC scanner output.
 *
 * Lines like:
 *   UID: 04 A1 B2 C3 D4 E5 F6
 *   ATQA: 44 00
 *   SAK: 08
 *   Type: Mifare Classic 1K
 * or:
 *   ISO14443-3A UID: AA BB CC DD
 */
export function parseNfcScanner(raw) {
  const tags = [];
  let current = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const uidMatch = /UID:\s*([0-9A-Fa-f\s]+)/.exec(trimmed);
    const atqaMatch = /ATQA:\s*([0-9A-Fa-f\s]+)/.exec(trimmed);
    const sakMatch = /SAK:\s*([0-9A-Fa-f]+)/.exec(trimmed);
    const typeMatch = /Type:\s*(.+)/.exec(trimmed);

    if (uidMatch) {
      if (current.uid) {
        tags.push(current);
        current = {};
      }
      current.uid = uidMatch[1].trim();
    }

    if (atqaMatch) current.atqa = atqaMatch[1].trim();
    if (sakMatch) current.sak = sakMatch[1].trim();
    if (typeMatch) current.type = typeMatch[1].trim();

    // ISO protocol detection
    if (trimmed.includes('ISO14443-3A')) current.protocol = 'ISO14443-3A';
    else if (trimmed.includes('ISO14443-3B')) current.protocol = 'ISO14443-3B';
    else if (trimmed.includes('ISO14443-4')) current.protocol = 'ISO14443-4';
    else if (trimmed.includes('ISO15693')) current.protocol = 'ISO15693';
    else if (trimmed.includes('Mifare')) {
      const mf = /(Mifare\s+\S+(?:\s+\S+)?)/.exec(trimmed);
      if (mf) current.type = mf[1];
    } else if (trimmed.includes('NTAG')) {
      const ntag = /(NTAG\d+)/.exec(trimmed);
      if (ntag) current.type = ntag[1];
    }
  }

  if (current.uid) tags.push(current);
  return tags;
}

/**
 * Parse RFID read output.
 *
 * Typical formats:
 *   Protocol: EM4100  Data: 01 02 03 04 05
 *   EM4100 ID: 0x0102030405
 *   HIDProx ID: 12345 FC: 100 Card: 54321
 */
export function parseRfidOutput(raw) {
  const cards = [];
  let current = {};

  const PROTOS = ['EM4100', 'HIDProx', 'Indala', 'FDX-B', 'Viking', 'Jablotron', 'Paradox', 'Keri', 'Gallagher'];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('Reading') || trimmed.includes('Press Ctrl') || trimmed.includes('abort')) continue;

    const protoMatch = /Protocol:\s*(\S+)/.exec(trimmed);
    const dataMatch = /Data:\s*([0-9A-Fa-f\s]+)/.exec(trimmed);
    const idMatch = /ID:\s*(0x[0-9A-Fa-f]+|[0-9A-Fa-f\s]+)/.exec(trimmed);
    const fcMatch = /FC:\s*(\d+)/.exec(trimmed);
    const cardMatch = /Card:\s*(\d+)/.exec(trimmed);

    // Protocol-prefixed lines
    for (const proto of PROTOS) {
      if (trimmed.startsWith(proto) || trimmed.includes(proto)) {
        if (current.protocol) {
          cards.push(current);
          current = {};
        }
        current.protocol = proto;
        break;
      }
    }

    if (protoMatch) {
      if (current.protocol) {
        cards.push(current);
        current = {};
      }
      current.protocol = protoMatch[1];
    }

    if (dataMatch) current.data = dataMatch[1].trim();
    if (idMatch) current.id = idMatch[1].trim();
    if (fcMatch) current.facility_code = fcMatch[1];
    if (cardMatch) current.card_number = cardMatch[1];
  }

  if (current.protocol || current.id) cards.push(current);
  return cards;
}
