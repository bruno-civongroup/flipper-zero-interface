/**
 * IR signal parsers — translates from ir.py parse_ir_output() and parse_ir_file().
 */

/**
 * Parse `ir rx` CLI output into structured signal data.
 *
 * Compact format: "NEC, A:0x04, C:0x08" or "NEC, A:0x04, C:0x08 R"
 * Verbose format: "Protocol: NEC Address: 04 Command: 08"
 */
export function parseIrOutput(raw) {
  const signals = [];
  const compactRe = /^(\w+),\s*A:(0x[0-9A-Fa-f]+),\s*C:(0x[0-9A-Fa-f]+)(\s+R)?$/;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('Receiving') || trimmed.includes('Press Ctrl')) continue;
    if (trimmed.startsWith('>') || trimmed.includes('INFRARED')) continue;

    // Compact format
    const compact = compactRe.exec(trimmed);
    if (compact) {
      signals.push({
        protocol: compact[1],
        address: compact[2],
        command: compact[3],
        repeat: !!compact[4],
      });
      continue;
    }

    // Verbose format
    const protoMatch = /Protocol:\s*(\S+)/.exec(trimmed);
    if (protoMatch) {
      const sig = { protocol: protoMatch[1] };
      const addrMatch = /Address:\s*([0-9A-Fa-fx\s]+?)(?:\s+\w+:|$)/.exec(trimmed);
      const cmdMatch = /Command:\s*([0-9A-Fa-fx\s]+?)(?:\s+\w+:|$)/.exec(trimmed);
      if (addrMatch) sig.address = addrMatch[1].trim();
      if (cmdMatch) sig.command = cmdMatch[1].trim();
      signals.push(sig);
    }
  }
  return signals;
}

/**
 * Parse a Flipper .ir file into a list of signal dicts.
 * Handles both 'parsed' (decoded protocol) and 'raw' (timing data) types.
 */
export function parseIrFile(content) {
  const signals = [];
  let current = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('Filetype:') || trimmed.startsWith('Version:')) {
      if (current.name) {
        signals.push(current);
        current = {};
      }
      continue;
    }

    if (trimmed.startsWith('name: ')) {
      if (current.name) signals.push(current);
      current = { name: trimmed.slice(6).trim() };
    } else if (trimmed.startsWith('type: ')) {
      current.type = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('protocol: ')) {
      current.protocol = trimmed.slice(10).trim();
    } else if (trimmed.startsWith('address: ')) {
      const rawAddr = trimmed.slice(9).trim();
      current.address = irBytesToHex(rawAddr);
      current.address_raw = rawAddr;
    } else if (trimmed.startsWith('command: ')) {
      const rawCmd = trimmed.slice(9).trim();
      current.command = irBytesToHex(rawCmd);
      current.command_raw = rawCmd;
    } else if (trimmed.startsWith('frequency: ')) {
      current.frequency = parseInt(trimmed.slice(11).trim(), 10);
    } else if (trimmed.startsWith('duty_cycle: ')) {
      current.duty_cycle = parseFloat(trimmed.slice(12).trim());
    } else if (trimmed.startsWith('data: ')) {
      current.raw_data = trimmed.slice(6).trim();
    }
  }

  if (current.name) signals.push(current);
  return signals;
}

/**
 * Convert .ir file address/command format to CLI-compatible hex.
 * "07 00 00 00" → "0x07"
 */
function irBytesToHex(raw) {
  const parts = raw.split(/\s+/);
  // Strip trailing 00 bytes
  while (parts.length > 1 && parts[parts.length - 1] === '00') parts.pop();
  // Reverse for big-endian reading and join
  let hexStr = parts.slice().reverse().join('');
  hexStr = hexStr.replace(/^0+/, '') || '0';
  return `0x${hexStr}`;
}
