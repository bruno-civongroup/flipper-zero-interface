/**
 * Parse `storage list` output from Flipper CLI.
 *
 * Format:
 *   [D] dirname
 *   [F] filename 1234b
 */

export function parseFileList(raw) {
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('[D]')) {
      entries.push({ name: trimmed.slice(3).trim(), type: 'directory', size: null });
    } else if (trimmed.startsWith('[F]')) {
      const content = trimmed.slice(3).trim();
      const lastSpace = content.lastIndexOf(' ');
      if (lastSpace !== -1) {
        const sizeStr = content.slice(lastSpace + 1);
        if (/^\d+b$/.test(sizeStr)) {
          entries.push({
            name: content.slice(0, lastSpace),
            type: 'file',
            size: parseInt(sizeStr.slice(0, -1), 10),
          });
          continue;
        }
      }
      entries.push({ name: content, type: 'file', size: null });
    }
  }
  return entries;
}
