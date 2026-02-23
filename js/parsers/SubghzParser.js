/**
 * Sub-GHz signal parser — translates from subghz.py parse_subghz_output().
 *
 * Decoded signals look like:
 *   Protocol: Princeton
 *   Bit: 24
 *   Key: 00 A0 5E
 *   TE: 350
 * or single-line:
 *   Protocol: Princeton Bit: 24 Key: 00 A0 5E TE: 350
 */

export function parseSubghzOutput(raw) {
  const signals = [];
  let current = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.includes('Listening') || trimmed.includes('Load_keystore')) continue;
    if (trimmed.includes('Press CTRL') || /frequency/i.test(trimmed)) continue;

    const protoMatch = /Protocol:\s*(\S+)/.exec(trimmed);
    const bitMatch = /Bit:\s*(\d+)/.exec(trimmed);
    const keyMatch = /Key:\s*([0-9A-Fa-f\s]+?)(?:\s+\w+:|$)/.exec(trimmed);
    const teMatch = /TE:\s*(\d+)/.exec(trimmed);

    if (protoMatch) {
      if (current.protocol) {
        signals.push(current);
        current = {};
      }
      current.protocol = protoMatch[1];
      if (bitMatch) current.bits = parseInt(bitMatch[1], 10);
      if (keyMatch) current.key = keyMatch[1].trim();
      if (teMatch) current.te = parseInt(teMatch[1], 10);
    } else if (bitMatch && Object.keys(current).length) {
      current.bits = parseInt(bitMatch[1], 10);
    } else if (keyMatch && Object.keys(current).length) {
      current.key = keyMatch[1].trim();
    } else if (teMatch && Object.keys(current).length) {
      current.te = parseInt(teMatch[1], 10);
    }
  }

  if (current.protocol) signals.push(current);
  return signals;
}
