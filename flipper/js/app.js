/**
 * Flipper Zero Interface — Main Application
 *
 * Pure client-side: uses Web Serial API to talk directly to the Flipper.
 * No backend needed. All state is local (localStorage for signal libraries).
 */

import { FlipperSerial } from './serial/FlipperSerial.js';
import { MarauderSerial } from './serial/MarauderSerial.js';
import { ScreenMirror } from './serial/ScreenMirror.js';
import { parseFileList } from './parsers/FileParser.js';
import { parseIrOutput, parseIrFile } from './parsers/IrParser.js';
import { parseSubghzOutput } from './parsers/SubghzParser.js';
import { parseNfcScanner, parseRfidOutput } from './parsers/NfcRfidParser.js';
import { parseApList, parseStationList } from './parsers/WifiParser.js';
import { irStore, subghzStore, nfcStore, rfidStore } from './storage/SignalStore.js';
import { downloadJSON, downloadCSV } from './ExportHelper.js';

// ── Browser compatibility check ──
if (!('serial' in navigator)) {
  document.getElementById('browserCheck').style.display = 'flex';
  // Hide everything else
  document.querySelector('header').style.display = 'none';
  document.querySelector('.main-layout').style.display = 'none';
  throw new Error('Web Serial API not supported');
}
document.getElementById('browserCheck').style.display = 'none';

// ── Singletons ──
const flipper = new FlipperSerial();
const marauder = new MarauderSerial();
const screenMirror = new ScreenMirror(flipper);

// ── State ──
let connected = false;
let currentPath = '/ext';
let commandHistory = [];
let historyIndex = -1;
let activeQuickCmd = 'device_info';

// Export/scan data for export buttons
let lastScanData = null;
let lastScanType = null;

// ── DOM refs ──
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const connectBtn = document.getElementById('connectBtn');
const terminalOutput = document.getElementById('terminalOutput');
const terminalInput = document.getElementById('terminalInput');
const fileList = document.getElementById('fileList');
const breadcrumb = document.getElementById('breadcrumb');
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const infoOutput = document.getElementById('infoOutput');
const infoPanelTitle = document.getElementById('infoPanelTitle');

// ── Toast / Confirm / Prompt ──
const toastContainer = document.getElementById('toastContainer');

function showToast(message, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

function showConfirm(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-dialog">
      <div class="modal-message"></div>
      <div class="modal-buttons">
        <button class="modal-btn" id="modalCancel">Cancel</button>
        <button class="modal-btn modal-btn-primary" id="modalOk">OK</button>
      </div>
    </div>`;
    overlay.querySelector('.modal-message').textContent = message;
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#modalOk').addEventListener('click', () => close(true));
    overlay.querySelector('#modalCancel').addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('#modalOk').focus();
  });
}

function showPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-dialog">
      <div class="modal-message"></div>
      <input type="text" class="modal-input" id="modalInput">
      <div class="modal-buttons">
        <button class="modal-btn" id="modalCancel">Cancel</button>
        <button class="modal-btn modal-btn-primary" id="modalOk">OK</button>
      </div>
    </div>`;
    overlay.querySelector('.modal-message').textContent = message;
    const input = overlay.querySelector('#modalInput');
    input.value = defaultValue;
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#modalOk').addEventListener('click', () => close(input.value));
    overlay.querySelector('#modalCancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value); else if (e.key === 'Escape') close(null); });
    input.focus();
    input.select();
  });
}

// ── Helpers ──
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Connection ──
function setConnected(state) {
  connected = state;
  statusDot.className = 'status-dot' + (state ? ' connected' : '');
  statusText.textContent = state ? 'Connected' : 'Disconnected';
  connectBtn.textContent = state ? 'Disconnect' : 'Connect Flipper';
  connectBtn.className = 'btn ' + (state ? 'btn-danger' : 'btn-primary');
  updateMarauderStatus();
}

flipper.onDisconnect(() => {
  setConnected(false);
  appendTerminal('sys', 'Flipper disconnected.');
});

async function toggleConnect() {
  if (connected) {
    await flipper.disconnect();
    setConnected(false);
    appendTerminal('sys', 'Disconnected.');
    infoOutput.innerHTML = '<div class="info-placeholder">Connect to Flipper to view device info</div>';
  } else {
    try {
      await flipper.connect();
      setConnected(true);
      appendTerminal('sys', 'Connected to Flipper Zero');
      loadDirectory(currentPath);
      runQuickCommand(activeQuickCmd);
    } catch (e) {
      if (e.name === 'NotFoundError') return; // User cancelled picker
      appendTerminal('err', `Connection failed: ${e.message}`);
    }
  }
}

// ── Info Panel ──
function renderInfoPanel(title, raw) {
  infoPanelTitle.textContent = title;
  const lines = raw.split('\n').filter(l => l.trim());
  const pairs = [];
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      pairs.push([line.substring(0, colonIdx).trim(), line.substring(colonIdx + 1).trim()]);
    } else {
      pairs.push([null, line.trim()]);
    }
  }
  const kvCount = pairs.filter(([k]) => k !== null).length;
  if (kvCount > lines.length * 0.5 && kvCount >= 2) {
    let html = '<table class="info-table">';
    for (const [key, val] of pairs) {
      html += key
        ? `<tr><td>${esc(key)}</td><td>${esc(val)}</td></tr>`
        : `<tr><td colspan="2">${esc(val)}</td></tr>`;
    }
    html += '</table>';
    infoOutput.innerHTML = html;
  } else {
    infoOutput.innerHTML = `<div class="info-raw">${esc(raw)}</div>`;
  }
}

async function runQuickCommand(cmd) {
  if (!connected) {
    infoOutput.innerHTML = '<div class="info-placeholder">Connect to Flipper first</div>';
    return;
  }
  const btn = document.querySelector(`.btn-quick[data-cmd="${cmd}"]`);
  if (btn) btn.classList.add('loading');
  try {
    const response = await flipper.sendCommand(cmd);
    const label = btn ? btn.dataset.label : cmd;
    renderInfoPanel(label, response || '(no output)');
  } catch (e) {
    infoOutput.innerHTML = `<div class="info-raw" style="color: var(--red)">${esc(e.message)}</div>`;
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

document.querySelectorAll('.btn-quick').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-quick').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeQuickCmd = btn.dataset.cmd;
    runQuickCommand(activeQuickCmd);
  });
});

document.getElementById('refreshInfoBtn').addEventListener('click', () => runQuickCommand(activeQuickCmd));

// ── Tabs ──
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${target}`).classList.add('active');

    document.getElementById('clearTermBtn').style.display = target === 'terminal' ? 'inline' : 'none';
    document.getElementById('exportTermBtn').style.display = target === 'terminal' ? 'inline' : 'none';
    document.getElementById('mkdirBtn').style.display = target === 'files' ? 'inline' : 'none';
    document.getElementById('refreshFilesBtn').style.display = target === 'files' ? 'inline' : 'none';

    if (target === 'wifi') updateMarauderStatus();
    if (target === 'ir') loadSavedSignals();
    if (target === 'subghz') loadSubghzLibrary();
    if (target === 'nfcrfid') loadNfcRfidLibrary();
    if (target === 'screen') resizeScreenCanvas();
    if (target === 'terminal') terminalInput.focus();
  });
});

// ── Terminal ──
function appendTerminal(type, text) {
  const div = document.createElement('div');
  div.className = type;
  div.textContent = text;
  terminalOutput.appendChild(div);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

document.getElementById('clearTermBtn').addEventListener('click', () => { terminalOutput.innerHTML = ''; });

document.getElementById('exportTermBtn').addEventListener('click', () => {
  const text = terminalOutput.innerText;
  if (!text.trim()) return;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `flipper_terminal_${ts}.log`;
  a.click();
  URL.revokeObjectURL(url);
});

async function runCommand(cmd) {
  if (!cmd.trim()) return;
  appendTerminal('cmd', `> ${cmd}`);
  commandHistory.unshift(cmd);
  historyIndex = -1;
  try {
    const response = await flipper.sendCommand(cmd);
    appendTerminal('resp', response || '(no output)');
  } catch (e) {
    appendTerminal('err', e.message);
  }
}

// ── Tab Autocomplete ──
const FLIPPER_COMMANDS = [
  'bt', 'crypto', 'date', 'free', 'gpio', 'i2c', 'ikey', 'info', 'input',
  'ir', 'led', 'loader', 'log', 'lfrfid', 'nfc', 'onewire', 'power',
  'property', 'ps', 'rfid', 'storage', 'subghz', 'uptime', 'vibro',
];
let autocompleteMatches = [];
let autocompleteIndex = -1;
let autocompletePrefix = '';

function getAutocompleteHint() {
  let existing = document.getElementById('autocompleteHint');
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'autocompleteHint';
    existing.className = 'autocomplete-hint';
    terminalInput.parentElement.parentElement.appendChild(existing);
  }
  return existing;
}

function showAutocompleteHint(matches, idx) {
  const hint = getAutocompleteHint();
  if (matches.length === 0) { hint.style.display = 'none'; return; }
  hint.innerHTML = matches.map((m, i) =>
    `<span class="${i === idx ? 'autocomplete-active' : ''}">${esc(m)}</span>`
  ).join(' ');
  hint.style.display = 'block';
}

function hideAutocomplete() {
  autocompleteMatches = [];
  autocompleteIndex = -1;
  autocompletePrefix = '';
  const hint = document.getElementById('autocompleteHint');
  if (hint) hint.style.display = 'none';
}

// ── Ctrl+R Search ──
let searchMode = false;

function enterSearchMode() {
  searchMode = true;
  let overlay = document.getElementById('searchOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'searchOverlay';
    overlay.className = 'terminal-search-overlay';
    overlay.innerHTML = `<span class="search-label">(reverse-i-search):</span> <input type="text" id="searchInput" class="search-input" placeholder="Type to search history...">
      <span id="searchResult" class="search-result"></span>`;
    terminalInput.parentElement.parentElement.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  const searchInput = document.getElementById('searchInput');
  searchInput.value = '';
  searchInput.focus();
  searchInput.oninput = (e) => {
    const q = e.target.value;
    const resultSpan = document.getElementById('searchResult');
    if (!q) { resultSpan.textContent = ''; return; }
    const match = commandHistory.find(cmd => cmd.toLowerCase().includes(q.toLowerCase()));
    resultSpan.textContent = match || '(no match)';
    resultSpan.style.color = match ? 'var(--text)' : 'var(--text-dim)';
  };
  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const match = document.getElementById('searchResult').textContent;
      if (match && match !== '(no match)') terminalInput.value = match;
      exitSearchMode();
      terminalInput.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      exitSearchMode();
      terminalInput.focus();
    }
  };
}

function exitSearchMode() {
  searchMode = false;
  const overlay = document.getElementById('searchOverlay');
  if (overlay) overlay.remove();
}

terminalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    hideAutocomplete();
    runCommand(terminalInput.value);
    terminalInput.value = '';
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const parts = terminalInput.value.split(/\s+/);
    const prefix = parts[0].toLowerCase();
    if (!prefix) return;
    if (autocompletePrefix !== prefix) {
      autocompletePrefix = prefix;
      autocompleteMatches = FLIPPER_COMMANDS.filter(c => c.startsWith(prefix));
      autocompleteIndex = 0;
    } else {
      autocompleteIndex = (autocompleteIndex + 1) % autocompleteMatches.length;
    }
    if (autocompleteMatches.length > 0) {
      parts[0] = autocompleteMatches[autocompleteIndex];
      terminalInput.value = parts.join(' ');
      showAutocompleteHint(autocompleteMatches, autocompleteIndex);
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    hideAutocomplete();
    if (historyIndex < commandHistory.length - 1) {
      historyIndex++;
      terminalInput.value = commandHistory[historyIndex];
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    hideAutocomplete();
    if (historyIndex > 0) {
      historyIndex--;
      terminalInput.value = commandHistory[historyIndex];
    } else {
      historyIndex = -1;
      terminalInput.value = '';
    }
  } else if (e.key === 'r' && e.ctrlKey) {
    e.preventDefault();
    enterSearchMode();
  } else if (e.key !== 'Tab') {
    hideAutocomplete();
  }
});

// ── File Browser ──
function renderBreadcrumb(path) {
  const parts = path.split('/').filter(Boolean);
  let html = '<a onclick="window._loadDirectory(\'/\')">root</a>';
  let cumulative = '';
  parts.forEach(p => {
    cumulative += '/' + p;
    const full = cumulative;
    html += ` / <a onclick="window._loadDirectory('${full}')">${p}</a>`;
  });
  breadcrumb.innerHTML = html;
}

async function loadDirectory(path) {
  currentPath = path;
  renderBreadcrumb(path);
  try {
    const raw = await flipper.sendCommand(`storage list ${path}`);
    const entries = parseFileList(raw);
    fileList.innerHTML = '';

    if (path !== '/' && path !== '/ext') {
      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
      const li = document.createElement('li');
      li.innerHTML = '<span class="icon">..</span> <span>Parent Directory</span>';
      li.onclick = () => loadDirectory(parentPath);
      fileList.appendChild(li);
    }

    entries.forEach(entry => {
      const li = document.createElement('li');
      const fullPath = `${path}/${entry.name}`.replace('//', '/');
      const icon = entry.type === 'directory' ? '\u{1F4C1}' : '\u{1F4C4}';
      const size = entry.size != null ? `<span class="size">${formatSize(entry.size)}</span>` : '';

      let actions = '<span class="file-actions">';
      if (entry.type === 'file') {
        actions += `<button class="file-action-btn file-action-download" onclick="event.stopPropagation();window._downloadFile('${esc(fullPath)}')" title="Download">&#8615;</button>`;
      }
      actions += `<button class="file-action-btn file-action-rename" onclick="event.stopPropagation();window._renameFile('${esc(fullPath)}')" title="Rename">&#9998;</button>`;
      actions += `<button class="file-action-btn file-action-delete" onclick="event.stopPropagation();window._deleteFile('${esc(fullPath)}')" title="Delete">&#10005;</button>`;
      actions += '</span>';

      li.innerHTML = `<span class="icon">${icon}</span> <span>${esc(entry.name)}</span>${size}${actions}`;

      if (entry.type === 'directory') {
        li.onclick = () => loadDirectory(fullPath);
      } else {
        li.onclick = () => viewFile(fullPath);
      }
      fileList.appendChild(li);
    });

    if (entries.length === 0) {
      fileList.innerHTML = '<li style="color: var(--text-dim)">Empty directory</li>';
    }
  } catch (e) {
    fileList.innerHTML = `<li style="color: var(--red)">${esc(e.message)}</li>`;
  }
}

async function viewFile(path) {
  appendTerminal('sys', `Reading file: ${path}`);
  try {
    const content = await flipper.sendCommand(`storage read ${path}`, 10000);
    appendTerminal('resp', content || '(empty file)');
    document.querySelector('.tab[data-tab="terminal"]').click();
  } catch (e) {
    appendTerminal('err', e.message);
  }
}

// File Upload
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => { uploadZone.classList.remove('dragover'); });
uploadZone.addEventListener('drop', (e) => { e.preventDefault(); uploadZone.classList.remove('dragover'); uploadFiles(e.dataTransfer.files); });
fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });

async function uploadFiles(files) {
  for (const file of files) {
    const dest = `${currentPath}/${file.name}`.replace('//', '/');
    appendTerminal('sys', `Uploading ${file.name} to ${dest}...`);
    try {
      const buffer = await file.arrayBuffer();
      const content = new Uint8Array(buffer);
      await flipper.writeFile(dest, content);
      appendTerminal('resp', `Uploaded ${file.name} (${formatSize(content.length)})`);
      showToast(`Uploaded: ${file.name}`, 'success');
    } catch (e) {
      appendTerminal('err', `Upload failed: ${e.message}`);
    }
  }
  loadDirectory(currentPath);
}

// File Actions
async function deleteFile(path) {
  if (!await showConfirm(`Delete "${path.split('/').pop()}"?\n\nPath: ${path}`)) return;
  try {
    await flipper.sendCommand(`storage remove ${path}`);
    showToast(`Deleted: ${path.split('/').pop()}`, 'success');
    loadDirectory(currentPath);
  } catch (e) {
    appendTerminal('err', `Delete failed: ${e.message}`);
  }
}

async function renameFile(path) {
  const oldName = path.split('/').pop();
  const newName = await showPrompt('Rename to:', oldName);
  if (!newName || newName === oldName) return;
  const parentDir = path.substring(0, path.lastIndexOf('/')) || '/';
  const newPath = `${parentDir}/${newName}`.replace('//', '/');
  try {
    await flipper.sendCommand(`storage rename ${path} ${newPath}`);
    showToast(`Renamed: ${oldName} → ${newName}`, 'success');
    loadDirectory(currentPath);
  } catch (e) {
    appendTerminal('err', `Rename failed: ${e.message}`);
  }
}

async function downloadFile(path) {
  try {
    const content = await flipper.sendCommand(`storage read ${path}`, 10000);
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop();
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    appendTerminal('err', `Download failed: ${e.message}`);
  }
}

async function createFolder() {
  const name = await showPrompt('New folder name:');
  if (!name) return;
  const folderPath = `${currentPath}/${name}`.replace('//', '/');
  try {
    await flipper.sendCommand(`storage mkdir ${folderPath}`);
    appendTerminal('sys', `Created folder: ${folderPath}`);
    loadDirectory(currentPath);
  } catch (e) {
    appendTerminal('err', `Create folder failed: ${e.message}`);
  }
}

document.getElementById('mkdirBtn').addEventListener('click', createFolder);

// Expose to inline onclick handlers
window._loadDirectory = loadDirectory;
window._deleteFile = deleteFile;
window._renameFile = renameFile;
window._downloadFile = downloadFile;

// ── Export helper ──
function exportButtons() {
  return `<div style="margin-top: 10px; display: flex; gap: 6px;">
    <button class="btn btn-sm btn-primary" onclick="window._exportScan('json')">Export JSON</button>
    <button class="btn btn-sm btn-primary" onclick="window._exportScan('csv')">Export CSV</button>
  </div>`;
}

window._exportScan = function(format) {
  if (!lastScanData || !lastScanType) return;
  if (format === 'csv') downloadCSV(lastScanType, lastScanData);
  else downloadJSON(lastScanType, lastScanData);
};

// ── WiFi Scanner (Marauder) ──
const marauderStatusDot = document.getElementById('marauderStatusDot');
const marauderStatusText = document.getElementById('marauderStatusText');
const wifiResults = document.getElementById('wifiResults');

// JS Bridge scripts for UART mode
const SCRIPTS_PATH = '/ext/apps/Scripts';
const SCAN_AP_SCRIPT = `let serial = require("serial");
serial.setup("usart", 115200);
delay(300);
let f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }
serial.write("stopscan\\n");
delay(1500);
f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }
serial.write("channel -h\\n");
delay(500);
f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }
serial.write("scanap\\n");
for (let i = 0; i < 150; i++) { serial.readAny(100); }
serial.write("stopscan\\n");
for (let i = 0; i < 20; i++) { serial.readAny(100); }
serial.write("list -a\\n");
delay(2000);
let out = "";
let c = serial.readAny(1000);
while (c !== undefined) { out += c; c = serial.readAny(500); }
print(out);
serial.end();`;

const SCAN_STA_SCRIPT = `let serial = require("serial");
serial.setup("usart", 115200);
delay(300);
let f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }
serial.write("stopscan\\n");
delay(1000);
f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }
serial.write("scansta\\n");
for (let i = 0; i < 200; i++) { serial.readAny(100); }
serial.write("stopscan\\n");
for (let i = 0; i < 20; i++) { serial.readAny(100); }
serial.write("list -s\\n");
delay(2000);
let out = "";
let c = serial.readAny(1000);
while (c !== undefined) { out += c; c = serial.readAny(500); }
print(out);
serial.end();`;

const STOP_SCAN_SCRIPT = `let serial = require("serial");
serial.setup("usart", 115200);
delay(300);
let f = serial.readAny(300);
while (f !== undefined) { f = serial.readAny(100); }
serial.write("stopscan\\n");
delay(1500);
let out = "";
let c = serial.readAny(500);
while (c !== undefined) { out += c; c = serial.readAny(200); }
print(out);
serial.end();`;

let _scriptsUploaded = false;

async function ensureScripts() {
  if (_scriptsUploaded) return;
  await flipper.writeFile(`${SCRIPTS_PATH}/mrd_scan_ap.js`, SCAN_AP_SCRIPT);
  await flipper.writeFile(`${SCRIPTS_PATH}/mrd_scan_sta.js`, SCAN_STA_SCRIPT);
  await flipper.writeFile(`${SCRIPTS_PATH}/mrd_stop.js`, STOP_SCAN_SCRIPT);
  _scriptsUploaded = true;
}

function updateMarauderStatus() {
  const ready = connected;
  marauderStatusDot.className = 'status-dot' + (ready ? ' connected' : '');
  marauderStatusText.textContent = ready ? 'Bridge via Flipper UART' : 'Connect Flipper first';
}

function rssiToBar(rssi) {
  if (rssi == null) return '';
  const abs = Math.abs(rssi);
  const pct = Math.max(0, Math.min(100, ((90 - abs) / 60) * 100));
  let cls = 'rssi-weak';
  if (pct > 75) cls = 'rssi-excellent';
  else if (pct > 50) cls = 'rssi-good';
  else if (pct > 25) cls = 'rssi-fair';
  return `<span class="rssi-bar ${cls}" style="width: ${Math.max(4, pct * 0.8)}px"></span> ${rssi}dBm`;
}

function renderApTable(aps, raw) {
  if (aps.length === 0) {
    wifiResults.innerHTML = `<div class="info-placeholder">No access points found.</div>
      <details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
    return;
  }
  aps.sort((a, b) => (b.rssi || -100) - (a.rssi || -100));
  let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">${aps.length} network(s) found</div>`;
  html += `<table class="ap-table"><thead><tr><th>#</th><th>SSID</th><th>Signal</th><th>CH</th><th>BSSID</th><th>Security</th></tr></thead><tbody>`;
  aps.forEach((ap, i) => {
    html += `<tr><td>${i + 1}</td><td class="ssid">${esc(ap.ssid || '(hidden)')}</td><td>${rssiToBar(ap.rssi)}</td><td>${ap.channel || '--'}</td><td class="bssid">${esc(ap.bssid)}</td><td>${esc(ap.encryption)}</td></tr>`;
  });
  html += `</tbody></table>`;
  html += exportButtons();
  html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
  wifiResults.innerHTML = html;
}

function renderStationTable(stations, raw) {
  if (stations.length === 0) {
    wifiResults.innerHTML = `<div class="info-placeholder">No stations found.</div>
      <details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
    return;
  }
  let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">${stations.length} station(s) found</div>`;
  html += `<table class="ap-table"><thead><tr><th>#</th><th>MAC Address</th><th>Details</th></tr></thead><tbody>`;
  stations.forEach((s, i) => {
    html += `<tr><td>${i + 1}</td><td class="bssid">${esc(s.mac)}</td><td>${esc(s.raw)}</td></tr>`;
  });
  html += `</tbody></table>`;
  html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
  wifiResults.innerHTML = html;
}

async function scanAccessPoints() {
  wifiResults.innerHTML = '<div class="scan-status"><span class="spinner"></span> Scanning for access points... (~7 seconds)</div>';
  document.getElementById('scanApBtn').disabled = true;
  document.getElementById('scanStaBtn').disabled = true;
  try {
    if (!connected) throw new Error('Flipper not connected');
    await ensureScripts();
    const raw = await flipper.runJs(`${SCRIPTS_PATH}/mrd_scan_ap.js`, 20000);
    const aps = parseApList(raw);
    lastScanType = 'wifi_ap';
    lastScanData = { access_points: aps, raw };
    renderApTable(aps, raw);
  } catch (e) {
    wifiResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Scan failed: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('scanApBtn').disabled = false;
    document.getElementById('scanStaBtn').disabled = false;
  }
}

async function scanStations() {
  wifiResults.innerHTML = '<div class="scan-status"><span class="spinner"></span> Scanning for client stations... (~10 seconds)</div>';
  document.getElementById('scanApBtn').disabled = true;
  document.getElementById('scanStaBtn').disabled = true;
  try {
    if (!connected) throw new Error('Flipper not connected');
    await ensureScripts();
    const raw = await flipper.runJs(`${SCRIPTS_PATH}/mrd_scan_sta.js`, 25000);
    const stations = parseStationList(raw);
    lastScanType = 'wifi_sta';
    lastScanData = { stations, raw };
    renderStationTable(stations, raw);
  } catch (e) {
    wifiResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Scan failed: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('scanApBtn').disabled = false;
    document.getElementById('scanStaBtn').disabled = false;
  }
}

async function stopScan() {
  try {
    if (!connected) return;
    await ensureScripts();
    await flipper.runJs(`${SCRIPTS_PATH}/mrd_stop.js`, 10000);
  } catch (e) {
    console.error('Stop scan failed:', e);
  }
}

// Raw Marauder command
async function sendRawMarauder() {
  const cmd = document.getElementById('marauderRawInput').value.trim();
  if (!cmd) return;
  wifiResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Sending: ${esc(cmd)}...</div>`;
  document.getElementById('marauderRawBtn').disabled = true;
  try {
    const script = `let serial = require("serial");
serial.setup("usart", 115200);
delay(200);
serial.readAny(200);
serial.write("${cmd}\\n");
delay(3000);
let out = "";
let c = serial.readAny(500);
while (c !== undefined) { out += c; c = serial.readAny(200); }
print(out);
serial.end();`;
    await flipper.writeFile(`${SCRIPTS_PATH}/mrd_raw.js`, script);
    const result = await flipper.runJs(`${SCRIPTS_PATH}/mrd_raw.js`, 15000);
    wifiResults.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">Command: <span style="color: var(--orange);">${esc(cmd)}</span></div>
      <pre style="white-space: pre-wrap; font-size: 12px; color: var(--text); line-height: 1.6;">${esc(result)}</pre>`;
  } catch (e) {
    wifiResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">${esc(e.message)}</div>`;
  } finally {
    document.getElementById('marauderRawBtn').disabled = false;
  }
}

document.getElementById('scanApBtn').addEventListener('click', scanAccessPoints);
document.getElementById('scanStaBtn').addEventListener('click', scanStations);
document.getElementById('stopScanBtn').addEventListener('click', stopScan);
document.getElementById('marauderRawBtn').addEventListener('click', sendRawMarauder);
document.getElementById('marauderRawInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRawMarauder(); });

// ── Sub-GHz Scanner ──
const subghzResults = document.getElementById('subghzResults');

async function subghzListen(raw = false) {
  const freq = parseInt(document.getElementById('subghzFreqSelect').value);
  const dur = parseInt(document.getElementById('subghzDuration').value);
  const freqMhz = (freq / 1_000_000).toFixed(2);
  const cmd = raw ? `subghz rx_raw ${freq}` : `subghz rx ${freq} 0`;

  subghzResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Listening on ${freqMhz} MHz for ${dur} seconds...</div>`;
  document.getElementById('subghzListenBtn').disabled = true;
  document.getElementById('subghzListenRawBtn').disabled = true;

  try {
    const output = await flipper.sendStreamingCommand(cmd, dur * 1000);
    if (raw) {
      subghzResults.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">RAW listen on ${freqMhz} MHz for ${dur}s</div>
        <pre style="white-space: pre-wrap; font-size: 12px; color: var(--text-dim); line-height: 1.6;">${esc(output)}</pre>`;
    } else {
      const signals = parseSubghzOutput(output);
      lastScanType = 'subghz';
      lastScanData = { signals, raw: output, frequency: freq, frequency_mhz: freq / 1_000_000, duration: dur, count: signals.length };
      renderSubghzSignals(signals, output, freq, dur);
    }
  } catch (e) {
    subghzResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Listen failed: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('subghzListenBtn').disabled = false;
    document.getElementById('subghzListenRawBtn').disabled = false;
  }
}

function renderSubghzSignals(signals, raw, freq, dur) {
  const freqMhz = (freq / 1_000_000).toFixed(2);
  let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">Listened on ${freqMhz} MHz for ${dur}s &mdash; ${signals.length} signal(s) captured</div>`;

  if (signals.length === 0) {
    html += `<div class="no-signals">No decoded signals captured during the listen window.<br><span style="font-size: 11px; color: var(--text-dim);">Try pressing a remote, doorbell, or other device while listening.</span></div>`;
  } else {
    signals.forEach((sig, i) => {
      const sigData = JSON.stringify({ protocol: sig.protocol || '', key: sig.key || '', bits: sig.bits || 24, frequency: freq, te: sig.te || null });
      html += `<div class="signal-card"><div class="signal-protocol">${esc(sig.protocol)}</div><div class="signal-details">`;
      if (sig.bits) html += `<div><span class="label">Bits:</span> <span class="value">${sig.bits}</span></div>`;
      if (sig.key) html += `<div><span class="label">Key:</span> <span class="signal-key">${esc(sig.key)}</span></div>`;
      if (sig.te) html += `<div><span class="label">TE:</span> <span class="value">${sig.te} \u00b5s</span></div>`;
      html += `</div><div style="margin-top: 8px; display: flex; gap: 6px; align-items: center;">
        <input type="text" class="port-select" id="subghzSaveName${i}" placeholder="Name (e.g. Garage Door)" style="width: 180px; min-width: 100px; margin-bottom: 0; padding: 4px 8px; font-size: 12px;">
        <button class="btn btn-sm btn-primary" onclick="window._saveSubghzSignal(${i}, ${esc(sigData)})">Save</button>
      </div></div>`;
    });
  }
  html += exportButtons();
  html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
  subghzResults.innerHTML = html;
}

window._saveSubghzSignal = function(index, sigData) {
  const nameInput = document.getElementById(`subghzSaveName${index}`);
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { nameInput.style.borderColor = 'var(--red)'; nameInput.focus(); return; }
  subghzStore.save({ name, protocol: sigData.protocol, key: sigData.key, bits: sigData.bits, frequency: sigData.frequency, te: sigData.te });
  nameInput.style.borderColor = 'var(--green)';
  nameInput.value = 'Saved!';
  nameInput.disabled = true;
  showToast(`Saved signal: ${name}`, 'success');
  loadSubghzLibrary();
};

function loadSubghzLibrary() {
  const container = document.getElementById('subghzSavedSignals');
  const signals = subghzStore.getAll();
  if (signals.length === 0) {
    container.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; padding: 16px; text-align: center;">No saved signals yet.<br><br>Capture signals with Listen, then save them here.</div>
      <div class="library-toolbar"><button class="btn btn-sm" onclick="window._importLibrary('subghz')">Import</button></div>`;
    return;
  }
  let html = '';
  signals.forEach(sig => {
    const freqMhz = (sig.frequency / 1_000_000).toFixed(2);
    html += `<div class="saved-signal">
      <button class="btn btn-sm btn-primary saved-signal-play" onclick="window._replaySubghzSignal('${sig.id}')" title="Transmit">&#9654;</button>
      <div class="saved-signal-info"><span class="saved-signal-name">${esc(sig.name)}</span><span class="saved-signal-detail">${esc(sig.protocol)} | ${esc(sig.key)} | ${freqMhz} MHz</span></div>
      <button class="btn btn-sm btn-danger" onclick="window._deleteSubghzSignal('${sig.id}')" title="Delete">&times;</button>
    </div>`;
  });
  html += `<div class="library-toolbar"><button class="btn btn-sm" onclick="window._exportLibrary('subghz')">Export</button><button class="btn btn-sm" onclick="window._importLibrary('subghz')">Import</button></div>`;
  container.innerHTML = html;
}

window._replaySubghzSignal = async function(id) {
  const sig = subghzStore.getById(id);
  if (!sig) return;
  try {
    let key = sig.key.trim();
    if (!key.startsWith('0x') && !key.startsWith('0X')) key = '0x' + key.replace(/ /g, '');
    await flipper.sendCommand(`subghz tx ${key} ${sig.frequency} ${sig.te || 400}`, 10000);
    const btn = document.querySelector(`[onclick="window._replaySubghzSignal('${id}')"]`);
    if (btn) { btn.textContent = '\u2713'; setTimeout(() => { btn.innerHTML = '&#9654;'; }, 600); }
  } catch (e) {
    showToast(`Transmit failed: ${e.message}`, 'error');
  }
};

window._deleteSubghzSignal = function(id) {
  subghzStore.delete(id);
  loadSubghzLibrary();
};

document.getElementById('subghzListenBtn').addEventListener('click', () => subghzListen(false));
document.getElementById('subghzListenRawBtn').addEventListener('click', () => subghzListen(true));

// ── NFC / RFID Scanner ──
const nfcrfidResults = document.getElementById('nfcrfidResults');

async function nfcrfidScan() {
  const mode = document.getElementById('nfcrfidMode').value;
  const dur = parseInt(document.getElementById('nfcrfidDuration').value);
  const modeLabel = mode === 'nfc' ? 'NFC (13.56 MHz)' : 'RFID (125 kHz)';

  nfcrfidResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Scanning ${modeLabel} for ${dur} seconds... Hold tag/card against Flipper.</div>`;
  document.getElementById('nfcrfidScanBtn').disabled = true;

  try {
    let raw, data;
    if (mode === 'nfc') {
      raw = await flipper.sendNfcCommand('scanner', dur * 1000);
      const tags = parseNfcScanner(raw);
      lastScanType = 'nfc';
      lastScanData = { tags, raw, count: tags.length, duration: dur };
      renderNfcResults(tags, raw, dur);
    } else {
      const modeArg = mode === 'rfid_indala' ? 'indala' : 'normal';
      raw = await flipper.sendStreamingCommand(`rfid read ${modeArg}`, dur * 1000);
      const cards = parseRfidOutput(raw);
      lastScanType = 'rfid';
      lastScanData = { cards, raw, count: cards.length, duration: dur, mode: modeArg };
      renderRfidResults(cards, raw, dur, modeArg);
    }
  } catch (e) {
    nfcrfidResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Scan failed: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('nfcrfidScanBtn').disabled = false;
  }
}

function renderNfcResults(tags, raw, dur) {
  let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">NFC scan (${dur}s) &mdash; ${tags.length} tag(s) found</div>`;
  if (tags.length === 0) {
    html += `<div class="no-signals">No NFC tags detected.<br><span style="font-size: 11px;">Hold the tag flat against the back of the Flipper during the scan.</span></div>`;
  } else {
    tags.forEach((tag, i) => {
      html += `<div class="tag-card"><div class="tag-type">${esc(tag.type || tag.protocol || 'NFC Tag')}</div><div class="tag-uid">${esc(tag.uid || 'Unknown UID')}</div><div class="tag-details">`;
      if (tag.atqa) html += `<div><span class="label">ATQA:</span> <span class="value">${esc(tag.atqa)}</span></div>`;
      if (tag.sak) html += `<div><span class="label">SAK:</span> <span class="value">${esc(tag.sak)}</span></div>`;
      if (tag.protocol) html += `<div><span class="label">Protocol:</span> <span class="value">${esc(tag.protocol)}</span></div>`;
      html += `</div><div style="margin-top: 8px; display: flex; gap: 6px; align-items: center;">
        <input type="text" class="port-select" id="nfcSaveName${i}" placeholder="Name (e.g. Office Badge)" style="width: 180px; min-width: 100px; margin-bottom: 0; padding: 4px 8px; font-size: 12px;">
        <button class="btn btn-sm btn-primary" onclick="window._saveNfcTag(${i})">Save</button>
      </div></div>`;
    });
  }
  html += exportButtons();
  html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
  nfcrfidResults.innerHTML = html;
  nfcrfidResults._nfcTags = tags;
}

function renderRfidResults(cards, raw, dur, mode) {
  let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">RFID ${mode} scan (${dur}s) &mdash; ${cards.length} card(s) read</div>`;
  if (cards.length === 0) {
    html += `<div class="no-signals">No RFID cards detected.<br><span style="font-size: 11px;">Hold the card against the back of the Flipper during the scan.</span></div>`;
  } else {
    cards.forEach((card, i) => {
      html += `<div class="tag-card" style="border-left-color: var(--orange);"><div class="tag-type" style="color: var(--orange);">${esc(card.protocol || 'RFID Card')}</div>`;
      if (card.id) html += `<div class="tag-uid">${esc(card.id)}</div>`;
      if (card.data) html += `<div class="tag-uid">${esc(card.data)}</div>`;
      html += `<div class="tag-details">`;
      if (card.facility_code) html += `<div><span class="label">Facility Code:</span> <span class="value">${esc(card.facility_code)}</span></div>`;
      if (card.card_number) html += `<div><span class="label">Card Number:</span> <span class="value">${esc(card.card_number)}</span></div>`;
      html += `</div><div style="margin-top: 8px; display: flex; gap: 6px; align-items: center;">
        <input type="text" class="port-select" id="rfidSaveName${i}" placeholder="Name (e.g. Front Door)" style="width: 180px; min-width: 100px; margin-bottom: 0; padding: 4px 8px; font-size: 12px;">
        <button class="btn btn-sm btn-primary" onclick="window._saveRfidCard(${i})">Save</button>
      </div></div>`;
    });
  }
  html += exportButtons();
  html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
  nfcrfidResults.innerHTML = html;
  nfcrfidResults._rfidCards = cards;
}

document.getElementById('nfcrfidScanBtn').addEventListener('click', nfcrfidScan);

window._saveNfcTag = function(index) {
  const nameInput = document.getElementById(`nfcSaveName${index}`);
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { nameInput.style.borderColor = 'var(--red)'; nameInput.focus(); return; }
  const tag = nfcrfidResults._nfcTags && nfcrfidResults._nfcTags[index];
  if (!tag) return;
  nfcStore.save({ name, type: tag.type || tag.protocol || 'NFC', uid: tag.uid || '', atqa: tag.atqa || '', sak: tag.sak || '', protocol: tag.protocol || '' });
  nameInput.style.borderColor = 'var(--green)';
  nameInput.value = 'Saved!';
  nameInput.disabled = true;
  showToast(`Saved NFC tag: ${name}`, 'success');
  loadNfcRfidLibrary();
};

window._saveRfidCard = function(index) {
  const nameInput = document.getElementById(`rfidSaveName${index}`);
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { nameInput.style.borderColor = 'var(--red)'; nameInput.focus(); return; }
  const card = nfcrfidResults._rfidCards && nfcrfidResults._rfidCards[index];
  if (!card) return;
  rfidStore.save({ name, protocol: card.protocol || 'RFID', id: card.id || '', data: card.data || '', facility_code: card.facility_code || '', card_number: card.card_number || '' });
  nameInput.style.borderColor = 'var(--green)';
  nameInput.value = 'Saved!';
  nameInput.disabled = true;
  showToast(`Saved RFID card: ${name}`, 'success');
  loadNfcRfidLibrary();
};

function loadNfcRfidLibrary() {
  const container = document.getElementById('nfcrfidSavedSignals');
  const nfcTags = nfcStore.getAll();
  const rfidCards = rfidStore.getAll();
  if (nfcTags.length === 0 && rfidCards.length === 0) {
    container.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; padding: 16px; text-align: center;">No saved tags yet.<br><br>Scan NFC/RFID tags, then save them here.</div>
      <div class="library-toolbar"><button class="btn btn-sm" onclick="window._importLibrary('nfc')">Import NFC</button><button class="btn btn-sm" onclick="window._importLibrary('rfid')">Import RFID</button></div>`;
    return;
  }
  let html = '';
  nfcTags.forEach(tag => {
    html += `<div class="saved-signal">
      <div class="saved-signal-info"><span class="saved-signal-name">${esc(tag.name)}</span><span class="saved-signal-detail" style="color: var(--blue);">${esc(tag.type || tag.protocol || 'NFC')} | ${esc(tag.uid)}</span></div>
      <button class="btn btn-sm btn-danger" onclick="window._deleteNfcRfidEntry('nfc','${tag.id}')" title="Delete">&times;</button>
    </div>`;
  });
  rfidCards.forEach(card => {
    html += `<div class="saved-signal">
      <div class="saved-signal-info"><span class="saved-signal-name">${esc(card.name)}</span><span class="saved-signal-detail" style="color: var(--orange);">${esc(card.protocol || 'RFID')} | ${esc(card.id || card.data)}</span></div>
      <button class="btn btn-sm btn-danger" onclick="window._deleteNfcRfidEntry('rfid','${card.id}')" title="Delete">&times;</button>
    </div>`;
  });
  html += `<div class="library-toolbar">`;
  if (nfcTags.length > 0) html += `<button class="btn btn-sm" onclick="window._exportLibrary('nfc')">Export NFC</button>`;
  if (rfidCards.length > 0) html += `<button class="btn btn-sm" onclick="window._exportLibrary('rfid')">Export RFID</button>`;
  html += `<button class="btn btn-sm" onclick="window._importLibrary('nfc')">Import NFC</button><button class="btn btn-sm" onclick="window._importLibrary('rfid')">Import RFID</button></div>`;
  container.innerHTML = html;
}

window._deleteNfcRfidEntry = function(type, id) {
  if (type === 'nfc') nfcStore.delete(id);
  else rfidStore.delete(id);
  loadNfcRfidLibrary();
};

// ── Infrared ──
const irResults = document.getElementById('irResults');
const irUniversalButtons = document.getElementById('irUniversalButtons');
const universalButtonMap = {
  tv: ['power', 'vol_up', 'vol_down', 'ch_up', 'ch_down', 'mute'],
  ac: ['off', 'cool_hi', 'cool_lo', 'heat_hi', 'heat_lo', 'dh'],
  audio: ['power', 'vol_up', 'vol_down', 'mute', 'next', 'prev'],
};

function renderUniversalButtons() {
  const type = document.getElementById('irUniversalType').value;
  const buttons = universalButtonMap[type] || [];
  irUniversalButtons.innerHTML = buttons
    .map(b => `<button class="btn btn-sm btn-primary" onclick="window._sendUniversalIR('${type}','${b}')">${b.replace(/_/g, ' ')}</button>`)
    .join('');
}

document.getElementById('irUniversalType').addEventListener('change', renderUniversalButtons);
renderUniversalButtons();

async function irLearn() {
  const mode = document.getElementById('irMode').value;
  const dur = parseInt(document.getElementById('irDuration').value);
  const cmd = mode === 'raw' ? 'ir rx raw' : 'ir rx';

  irResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Learning IR signal for ${dur} seconds... Point a remote at the Flipper.</div>`;
  document.getElementById('irLearnBtn').disabled = true;

  try {
    const output = await flipper.sendStreamingCommand(cmd, dur * 1000);
    if (mode === 'raw') {
      irResults.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">RAW IR capture (${dur}s)</div>
        <pre style="white-space: pre-wrap; font-size: 12px; color: var(--text-dim); line-height: 1.6;">${esc(output)}</pre>`;
    } else {
      const signals = parseIrOutput(output);
      renderIrSignals(signals, output, dur);
    }
  } catch (e) {
    irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Learn failed: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('irLearnBtn').disabled = false;
  }
}

function renderIrSignals(signals, raw, dur) {
  let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">IR learn (${dur}s) &mdash; ${signals.length} signal(s) captured</div>`;

  if (signals.length === 0) {
    html += `<div class="no-signals">No decoded IR signals captured.<br><span style="font-size: 11px; color: var(--text-dim);">Point a remote directly at the Flipper's IR receiver and press a button during the learn window.</span></div>`;
  } else {
    const seen = new Set();
    const unique = signals.filter(sig => {
      if (sig.repeat) return false;
      const key = `${sig.protocol}|${sig.address}|${sig.command}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.forEach((sig, i) => {
      const sigData = JSON.stringify({ protocol: sig.protocol, address: sig.address || '', command: sig.command || '' });
      html += `<div class="signal-card"><div class="signal-protocol">${esc(sig.protocol)}</div><div class="signal-details">`;
      if (sig.address) html += `<div><span class="label">Address:</span> <span class="signal-key">${esc(sig.address)}</span></div>`;
      if (sig.command) html += `<div><span class="label">Command:</span> <span class="signal-key">${esc(sig.command)}</span></div>`;
      html += `</div><div style="margin-top: 8px; display: flex; gap: 6px; align-items: center;">
        <button class="btn btn-sm btn-primary" onclick="window._fillIrTransmit('${esc(sig.protocol)}','${esc(sig.address || '')}','${esc(sig.command || '')}')">Use for Transmit</button>
        <input type="text" class="port-select" id="irSaveName${i}" placeholder="Name (e.g. TV Power)" style="width: 160px; min-width: 100px; margin-bottom: 0; padding: 4px 8px; font-size: 12px;">
        <button class="btn btn-sm btn-primary" onclick="window._saveIrSignal(${i}, ${esc(sigData)})">Save</button>
      </div></div>`;
    });

    if (unique.length < signals.length) {
      html += `<div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">${signals.length - unique.length} repeat(s) filtered</div>`;
    }
  }
  html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);"><summary style="cursor: pointer; color: var(--orange);">Raw output</summary><pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre></details>`;
  irResults.innerHTML = html;
}

window._saveIrSignal = function(index, sigData) {
  const nameInput = document.getElementById(`irSaveName${index}`);
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { nameInput.style.borderColor = 'var(--red)'; nameInput.focus(); return; }
  irStore.save({ name, protocol: sigData.protocol, address: sigData.address, command: sigData.command });
  nameInput.style.borderColor = 'var(--green)';
  nameInput.value = 'Saved!';
  nameInput.disabled = true;
  showToast(`Saved signal: ${name}`, 'success');
  loadSavedSignals();
};

window._fillIrTransmit = function(protocol, address, command) {
  const sel = document.getElementById('irProtocol');
  for (const opt of sel.options) { if (opt.value === protocol) { opt.selected = true; break; } }
  document.getElementById('irAddress').value = address;
  document.getElementById('irCommand').value = command;
};

async function irTransmit() {
  const protocol = document.getElementById('irProtocol').value;
  const address = document.getElementById('irAddress').value.trim();
  const command = document.getElementById('irCommand').value.trim();
  if (!address || !command) { irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Enter address and command values</div>`; return; }
  document.getElementById('irTransmitBtn').disabled = true;
  irResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Transmitting IR: ${protocol} ${address} ${command}...</div>`;
  try {
    const result = await flipper.sendCommand(`ir tx ${protocol} ${address} ${command}`);
    irResults.innerHTML = `<div class="signal-card"><div class="signal-protocol">Transmitted</div><div class="signal-details">
      <div><span class="label">Protocol:</span> <span class="value">${esc(protocol)}</span></div>
      <div><span class="label">Address:</span> <span class="signal-key">${esc(address)}</span></div>
      <div><span class="label">Command:</span> <span class="signal-key">${esc(command)}</span></div>
    </div></div>`;
  } catch (e) {
    irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Transmit failed: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('irTransmitBtn').disabled = false;
  }
}

window._sendUniversalIR = async function(remoteType, button) {
  irResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Sending ${remoteType} ${button.replace(/_/g, ' ')}...</div>`;
  try {
    const result = await flipper.sendCommand(`ir universal ${remoteType} ${button}`, 10000);
    irResults.innerHTML = `<div class="signal-card"><div class="signal-protocol">Universal: ${esc(remoteType)} &mdash; ${esc(button.replace(/_/g, ' '))}</div>
      <div style="font-size: 12px; color: var(--text-dim); margin-top: 6px;">${esc(result || 'Sent')}</div></div>`;
  } catch (e) {
    irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Universal failed: ${esc(e.message)}</div>`;
  }
};

document.getElementById('irLearnBtn').addEventListener('click', irLearn);
document.getElementById('irTransmitBtn').addEventListener('click', irTransmit);

// ── Signal-to-Remote-Slot Mapper ──
function mapSignalToSlot(name) {
  const n = name.toLowerCase().replace(/[\s\-\.]+/g, '_').replace(/[^a-z0-9_]/g, '');
  const exact = {
    'power': 'power', 'pwr': 'power', 'on_off': 'power', 'standby': 'power', 'power_toggle': 'power',
    'mute': 'mute', 'source': 'source', 'input': 'source', 'tv_av': 'source', 'hdmi': 'source', 'src': 'source',
    'vol_up': 'vol_up', 'volume_up': 'vol_up', 'vol_dn': 'vol_down', 'vol_down': 'vol_down', 'volume_down': 'vol_down',
    'ch_next': 'ch_up', 'ch_up': 'ch_up', 'channel_up': 'ch_up',
    'ch_prev': 'ch_down', 'ch_down': 'ch_down', 'channel_down': 'ch_down', 'ch_dn': 'ch_down',
    'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right',
    'ok': 'ok', 'select': 'ok', 'enter': 'ok', 'menu': 'menu', 'tools': 'tools',
    'home': 'home', 'smarthub': 'home', 'smart_hub': 'home', 'info': 'info', 'guide': 'guide',
    'back': 'back', 'return': 'back', 'ret': 'back', 'previous': 'back', 'exit': 'exit',
    '0': 'num0', '1': 'num1', '2': 'num2', '3': 'num3', '4': 'num4',
    '5': 'num5', '6': 'num6', '7': 'num7', '8': 'num8', '9': 'num9',
  };
  if (exact[n]) return exact[n];
  if (n.includes('power') || n.includes('pwr') || n.includes('on_off')) return 'power';
  if (n.includes('mute')) return 'mute';
  if (n.includes('source') || n.includes('input') || n.includes('hdmi')) return 'source';
  if ((n.includes('vol') || n.includes('volume')) && (n.includes('up') || n.includes('+'))) return 'vol_up';
  if ((n.includes('vol') || n.includes('volume')) && (n.includes('dn') || n.includes('down') || n.includes('-'))) return 'vol_down';
  if ((n.includes('ch') || n.includes('channel')) && (n.includes('up') || n.includes('next') || n.includes('+'))) return 'ch_up';
  if ((n.includes('ch') || n.includes('channel')) && (n.includes('dn') || n.includes('down') || n.includes('prev') || n.includes('-'))) return 'ch_down';
  if (n.includes('menu')) return 'menu';
  if (n.includes('home') || n.includes('smart')) return 'home';
  if (n.includes('info')) return 'info';
  if (n.includes('guide')) return 'guide';
  if (n.includes('back') || n.includes('return')) return 'back';
  if (n.includes('exit')) return 'exit';
  return null;
}

function loadSavedSignals() {
  const container = document.getElementById('irSavedSignals');
  const signals = irStore.getAll();
  if (signals.length === 0) {
    container.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; padding: 16px; text-align: center;">No signals yet.<br><br>Capture signals with Learn or import from IRDB.</div>
      <div class="library-toolbar"><button class="btn btn-sm" onclick="window._importLibrary('ir')">Import</button></div>`;
    return;
  }

  const slotMap = {};
  const unmapped = [];
  for (const sig of signals) {
    const slot = mapSignalToSlot(sig.name);
    if (slot && !slotMap[slot]) slotMap[slot] = sig;
    else unmapped.push(sig);
  }

  function btn(slotId, label, cls) {
    const sig = slotMap[slotId];
    if (sig) {
      return `<button class="ir-rmt-btn mapped ${cls || ''}" onclick="window._replaySignal('${sig.id}')" title="${esc(sig.name)}&#10;${esc(sig.protocol)} ${esc(sig.address)} ${esc(sig.command)}"><span class="rmt-label">${label}</span><span class="rmt-delete" onclick="event.stopPropagation();window._deleteSignal('${sig.id}')">&times;</span></button>`;
    }
    return `<button class="ir-rmt-btn empty ${cls || ''}" disabled><span class="rmt-label">${label}</span></button>`;
  }

  let html = '<div class="ir-remote">';
  html += '<div class="ir-rmt-row">' + btn('power', 'PWR', 'rmt-power') + '<span class="rmt-spacer"></span>' + btn('source', 'SRC') + btn('mute', 'MUTE') + '</div>';
  html += '<div class="ir-rmt-divider"></div>';
  html += '<div class="ir-rmt-numpad">';
  for (let i = 1; i <= 9; i++) html += btn('num' + i, '' + i);
  html += '<div></div>' + btn('num0', '0') + '<div></div></div>';
  html += '<div class="ir-rmt-divider"></div>';
  html += '<div class="ir-rmt-nav">';
  html += '<div class="ir-rmt-strip">' + btn('vol_up', 'V+') + btn('vol_down', 'V\u2212') + '</div>';
  html += '<div class="ir-rmt-dpad">';
  html += '<div></div>' + btn('up', '\u25B2', 'rmt-arrow') + '<div></div>';
  html += btn('left', '\u25C0', 'rmt-arrow') + btn('ok', 'OK', 'rmt-ok') + btn('right', '\u25B6', 'rmt-arrow');
  html += '<div></div>' + btn('down', '\u25BC', 'rmt-arrow') + '<div></div></div>';
  html += '<div class="ir-rmt-strip">' + btn('ch_up', 'CH+') + btn('ch_down', 'CH\u2212') + '</div></div>';
  html += '<div class="ir-rmt-divider"></div>';
  html += '<div class="ir-rmt-row">' + btn('menu', 'MENU') + btn('home', 'HOME') + btn('info', 'INFO') + '</div>';
  html += '<div class="ir-rmt-row">' + btn('back', 'BACK') + '<span class="rmt-spacer"></span>' + btn('exit', 'EXIT') + '</div>';
  if (slotMap['guide'] || slotMap['tools']) {
    html += '<div class="ir-rmt-row">';
    if (slotMap['guide']) html += btn('guide', 'GUIDE');
    if (slotMap['tools']) html += btn('tools', 'TOOLS');
    html += '</div>';
  }
  html += '</div>';

  if (unmapped.length > 0) {
    html += '<div class="ir-rmt-overflow">';
    html += `<div class="ir-rmt-overflow-title">Other (${unmapped.length})</div>`;
    unmapped.forEach(sig => {
      html += `<div class="saved-signal">
        <button class="btn btn-sm btn-primary saved-signal-play" onclick="window._replaySignal('${sig.id}')" title="Transmit">&#9654;</button>
        <div class="saved-signal-info"><span class="saved-signal-name">${esc(sig.name)}</span><span class="saved-signal-detail">${esc(sig.protocol)} ${esc(sig.address)} ${esc(sig.command)}</span></div>
        <button class="btn btn-sm btn-danger" onclick="window._deleteSignal('${sig.id}')" title="Delete">&times;</button>
      </div>`;
    });
    html += '</div>';
  }
  html += `<div class="library-toolbar"><button class="btn btn-sm" onclick="window._exportLibrary('ir')">Export</button><button class="btn btn-sm" onclick="window._importLibrary('ir')">Import</button></div>`;
  container.innerHTML = html;
}

window._replaySignal = async function(id) {
  const sig = irStore.getById(id);
  if (!sig) return;
  try {
    await flipper.sendCommand(`ir tx ${sig.protocol} ${sig.address} ${sig.command}`);
    const btn = document.querySelector(`[onclick="window._replaySignal('${id}')"]`);
    if (btn) {
      if (btn.classList.contains('ir-rmt-btn')) {
        const origBg = btn.style.background;
        const origBorder = btn.style.borderColor;
        btn.style.background = 'var(--green)';
        btn.style.borderColor = 'var(--green)';
        btn.style.color = '#000';
        setTimeout(() => { btn.style.background = origBg; btn.style.borderColor = origBorder; btn.style.color = ''; }, 400);
      } else {
        btn.textContent = '\u2713';
        setTimeout(() => { btn.innerHTML = '&#9654;'; }, 600);
      }
    }
  } catch (e) {
    showToast(`Transmit failed: ${e.message}`, 'error');
  }
};

window._deleteSignal = function(id) {
  irStore.delete(id);
  loadSavedSignals();
};

// ── IRDB Browser (direct GitHub API) ──
const irdbOverlay = document.getElementById('irdbOverlay');
const irdbBody = document.getElementById('irdbBody');
const irdbBreadcrumb = document.getElementById('irdbBreadcrumb');
const IRDB_REPO = 'Lucaslhm/Flipper-IRDB';
const IRDB_BRANCH = 'main';
const IRDB_HIDDEN = new Set(['.github', '_Converted_']);
const _irdbCache = new Map();

// ── IRDB Search (GitHub Trees API + client-side filter) ──
const irdbSearchInput = document.getElementById('irdbSearchInput');
const irdbSearchStatus = document.getElementById('irdbSearchStatus');
let _irdbTree = null;
let _irdbTreeLoading = false;
let _irdbSearchDebounce = null;
let _irdbLastResults = null;

async function irdbLoadTree() {
  if (_irdbTree) return _irdbTree;
  if (_irdbTreeLoading) {
    // Wait for in-flight load
    return new Promise(resolve => {
      const check = setInterval(() => { if (_irdbTree || !_irdbTreeLoading) { clearInterval(check); resolve(_irdbTree); } }, 100);
    });
  }
  _irdbTreeLoading = true;
  irdbSearchStatus.textContent = 'Loading index...';
  try {
    const url = `https://api.github.com/repos/${IRDB_REPO}/git/trees/${IRDB_BRANCH}?recursive=1`;
    const resp = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
    if (resp.status === 403) throw new Error('Rate limited');
    if (!resp.ok) throw new Error(`API error ${resp.status}`);
    const json = await resp.json();
    _irdbTree = json.tree.filter(entry => {
      if (entry.type !== 'blob' || !entry.path.endsWith('.ir')) return false;
      const first = entry.path.split('/')[0];
      return !IRDB_HIDDEN.has(first);
    }).map(entry => ({ path: entry.path, size: entry.size || 0 }));
    irdbSearchStatus.textContent = '';
    return _irdbTree;
  } catch (e) {
    irdbSearchStatus.textContent = 'Index unavailable';
    _irdbTreeLoading = false;
    return null;
  }
}

function irdbSearch(query, tree) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !tree) return [];

  const scored = [];
  for (const entry of tree) {
    const pathLower = entry.path.toLowerCase();
    const parts = pathLower.split('/');
    const filename = parts[parts.length - 1];

    let match = true;
    let score = 0;
    for (const term of terms) {
      if (pathLower.indexOf(term) === -1) { match = false; break; }
      // Filename match is worth more
      if (filename.indexOf(term) !== -1) score += 10;
      else score += 3;
      // Word-boundary bonus (after _ / or start)
      const re = new RegExp('(?:^|[/_])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (re.test(pathLower)) score += 5;
    }
    if (match) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 100).map(s => s.entry);
}

function irdbRenderSearchResults(results, query) {
  if (!results || results.length === 0) {
    irdbBody.innerHTML = '<div class="info-placeholder">No matching files found</div>';
    return;
  }
  let html = `<div style="font-size: 11px; color: var(--text-dim); padding: 4px 12px; margin-bottom: 4px;">${results.length}${results.length >= 100 ? '+' : ''} result(s)</div>`;
  for (const entry of results) {
    const parts = entry.path.split('/');
    const filename = parts.pop().replace('.ir', '').replace(/_/g, ' ');
    const context = parts.join(' / ').replace(/_/g, ' ');
    const sizeStr = entry.size ? `${(entry.size / 1024).toFixed(1)} KB` : '';
    html += `<div class="irdb-item" onclick="window._irdbOpenFile('${entry.path}')">` +
      `<span class="icon">\u{1F4E1}</span>` +
      `<span>${esc(filename)}</span>` +
      `<span class="irdb-search-path">${esc(context)}</span>` +
      `<span class="size">${sizeStr}</span>` +
      `</div>`;
  }
  irdbBody.innerHTML = html;
}

irdbSearchInput.addEventListener('input', () => {
  clearTimeout(_irdbSearchDebounce);
  const query = irdbSearchInput.value.trim();
  if (!query) {
    irdbSearchStatus.textContent = '';
    irdbBrowse('');
    return;
  }
  _irdbSearchDebounce = setTimeout(async () => {
    const tree = await irdbLoadTree();
    if (!tree) return;
    const results = irdbSearch(query, tree);
    _irdbLastResults = results;
    irdbRenderSearchResults(results, query);
    irdbBreadcrumb.innerHTML = '';
  }, 250);
});

irdbSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    irdbSearchInput.value = '';
    irdbSearchStatus.textContent = '';
    _irdbLastResults = null;
    irdbBrowse('');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // If results haven't loaded yet, force an immediate search
    const query = irdbSearchInput.value.trim();
    if (!query) return;
    clearTimeout(_irdbSearchDebounce);
    (async () => {
      const tree = await irdbLoadTree();
      if (!tree) return;
      const results = irdbSearch(query, tree);
      _irdbLastResults = results;
      if (results.length === 1) {
        irdbOpenFile(results[0].path);
      } else {
        irdbRenderSearchResults(results, query);
        irdbBreadcrumb.innerHTML = '';
      }
    })();
  }
});

document.getElementById('irdbOpenBtn').addEventListener('click', () => { irdbOverlay.style.display = 'flex'; irdbBrowse(''); irdbSearchInput.value = ''; setTimeout(() => irdbSearchInput.focus(), 50); });
document.getElementById('irdbCloseBtn').addEventListener('click', () => { irdbOverlay.style.display = 'none'; });
irdbOverlay.addEventListener('click', (e) => { if (e.target === irdbOverlay) irdbOverlay.style.display = 'none'; });

function irdbRenderBreadcrumb(path) {
  let html = '<a onclick="window._irdbBrowse(\'\')">IRDB</a>';
  if (path) {
    const parts = path.split('/');
    let cumulative = '';
    parts.forEach(p => {
      cumulative += (cumulative ? '/' : '') + p;
      const full = cumulative;
      html += ` / <a onclick="window._irdbBrowse('${full}')">${p}</a>`;
    });
  }
  irdbBreadcrumb.innerHTML = html;
}

async function irdbBrowse(path) {
  if (!path) irdbSearchInput.value = '';
  irdbRenderBreadcrumb(path);
  irdbBody.innerHTML = '<div class="scan-status"><span class="spinner"></span> Loading...</div>';

  try {
    let data;
    const cacheKey = `dir:${path}`;
    const cached = _irdbCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 600000) {
      data = cached.data;
    } else {
      const url = `https://api.github.com/repos/${IRDB_REPO}/contents/${path}?ref=${IRDB_BRANCH}`;
      const resp = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
      if (resp.status === 403) throw new Error('GitHub API rate limited. Try again later.');
      if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
      data = await resp.json();
      _irdbCache.set(cacheKey, { data, time: Date.now() });
    }

    const children = [];
    for (const item of data) {
      if (IRDB_HIDDEN.has(item.name)) continue;
      if (item.type === 'dir') children.push({ name: item.name, type: 'directory' });
      else if (item.type === 'file' && item.name.endsWith('.ir')) children.push({ name: item.name, type: 'file', size: item.size || 0 });
    }
    children.sort((a, b) => (a.type !== 'directory') - (b.type !== 'directory') || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    let html = '';
    children.forEach(item => {
      if (item.type === 'directory') {
        const full = path ? path + '/' + item.name : item.name;
        html += `<div class="irdb-item" onclick="window._irdbBrowse('${full}')"><span class="icon">\u{1F4C1}</span><span>${esc(item.name.replace(/_/g, ' '))}</span></div>`;
      } else {
        const full = path ? path + '/' + item.name : item.name;
        const sizeStr = item.size ? `${(item.size / 1024).toFixed(1)} KB` : '';
        html += `<div class="irdb-item" onclick="window._irdbOpenFile('${full}')"><span class="icon">\u{1F4E1}</span><span>${esc(item.name.replace(/_/g, ' ').replace('.ir', ''))}</span><span class="size">${sizeStr}</span></div>`;
      }
    });
    irdbBody.innerHTML = html || '<div class="info-placeholder">Empty directory</div>';
  } catch (e) {
    irdbBody.innerHTML = `<div class="info-placeholder" style="color: var(--red)">${esc(e.message)}</div>`;
  }
}

async function irdbOpenFile(path) {
  irdbRenderBreadcrumb(path);
  irdbBody.innerHTML = '<div class="scan-status"><span class="spinner"></span> Fetching signals...</div>';

  try {
    const url = `https://raw.githubusercontent.com/${IRDB_REPO}/${IRDB_BRANCH}/${path}`;
    const resp = await fetch(url);
    if (resp.status === 403) throw new Error('GitHub rate limited. Try again later.');
    if (!resp.ok) throw new Error('File not found in IRDB');
    const content = await resp.text();

    const signals = parseIrFile(content);
    const parsed = signals.filter(s => s.type === 'parsed');
    const raw = signals.filter(s => s.type === 'raw');

    let html = `<div style="font-size: 12px; color: var(--text-dim); padding: 4px 12px; margin-bottom: 4px;">${signals.length} signal(s) &mdash; ${parsed.length} decoded, ${raw.length} raw</div>`;

    if (parsed.length > 0) {
      html += `<div style="padding: 4px 12px; margin-bottom: 4px;"><label style="font-size: 12px; cursor: pointer; color: var(--text-dim);"><input type="checkbox" id="irdbSelectAll" onchange="window._irdbToggleAll(this.checked)" checked> Select all decoded</label></div>`;
      parsed.forEach((sig, i) => {
        html += `<div class="irdb-signal"><input type="checkbox" class="irdb-check" data-index="${i}" checked><span class="sig-name">${esc(sig.name)}</span><span class="sig-detail">${esc(sig.protocol)} ${esc(sig.address)} ${esc(sig.command)}</span></div>`;
      });
    }

    if (raw.length > 0) {
      html += `<div style="padding: 8px 12px; margin-top: 8px; font-size: 11px; color: var(--text-dim);">${raw.length} raw signal(s) (not importable — raw timing data without decoded protocol)</div>`;
      raw.forEach(sig => {
        html += `<div class="irdb-signal" style="opacity: 0.5;"><span class="sig-name">${esc(sig.name)}</span><span class="sig-raw-tag">raw ${sig.frequency ? sig.frequency + ' Hz' : ''}</span></div>`;
      });
    }

    if (parsed.length > 0) {
      html += `<div class="irdb-actions"><button class="btn btn-sm btn-primary" onclick="window._irdbImportSelected()">Import Selected</button><span id="irdbImportStatus" style="font-size: 12px; color: var(--text-dim);"></span></div>`;
    }

    irdbBody.innerHTML = html;
    irdbBody._parsedSignals = parsed;
  } catch (e) {
    irdbBody.innerHTML = `<div class="info-placeholder" style="color: var(--red)">${esc(e.message)}</div>`;
  }
}

window._irdbBrowse = irdbBrowse;
window._irdbOpenFile = irdbOpenFile;
window._irdbToggleAll = function(checked) {
  document.querySelectorAll('.irdb-check').forEach(cb => { cb.checked = checked; });
};

window._irdbImportSelected = function() {
  const parsed = irdbBody._parsedSignals || [];
  const checks = document.querySelectorAll('.irdb-check');
  const selected = [];
  checks.forEach(cb => {
    if (cb.checked) {
      const sig = parsed[parseInt(cb.dataset.index)];
      if (sig) selected.push({ name: sig.name, protocol: sig.protocol, address: sig.address, command: sig.command });
    }
  });
  if (selected.length === 0) return;
  const status = document.getElementById('irdbImportStatus');
  status.textContent = 'Importing...';
  const imported = irStore.importBulk(selected);
  status.style.color = 'var(--green)';
  status.textContent = `Imported ${imported.length} signal(s)`;
  loadSavedSignals();
};

// ── Remote Control (D-pad) ──
const remoteLog = document.getElementById('remoteLog');

function logRemote(msg) {
  const div = document.createElement('div');
  div.textContent = msg;
  remoteLog.prepend(div);
  while (remoteLog.children.length > 20) remoteLog.lastChild.remove();
}

document.querySelectorAll('.dpad-btn').forEach(btn => {
  const key = btn.dataset.key;
  let pressStart = 0;
  let sent = false;

  function startPress(e) {
    e.preventDefault();
    btn.classList.add('pressed');
    pressStart = Date.now();
    sent = false;
  }

  async function endPress(e) {
    e.preventDefault();
    btn.classList.remove('pressed');
    if (sent) return;
    sent = true;
    const elapsed = Date.now() - pressStart;
    const pressType = elapsed >= 500 ? 'long' : 'short';
    logRemote(`${key} (${pressType})`);
    try {
      await flipper.sendCommand(`input send ${key} ${pressType}`);
    } catch (e) {
      logRemote(`Error: ${e.message}`);
    }
  }

  btn.addEventListener('mousedown', startPress);
  btn.addEventListener('mouseup', endPress);
  btn.addEventListener('mouseleave', (e) => { if (pressStart && !sent) endPress(e); });
  btn.addEventListener('touchstart', startPress, { passive: false });
  btn.addEventListener('touchend', endPress, { passive: false });
  btn.addEventListener('touchcancel', endPress, { passive: false });
});

// ── Screen Mirror ──
const screenStartBtn = document.getElementById('screenStartBtn');
const screenStopBtn = document.getElementById('screenStopBtn');
const screenShotBtn = document.getElementById('screenShotBtn');
const screenStatusDot = document.getElementById('screenStatusDot');
const screenStatusText = document.getElementById('screenStatusText');
const screenFps = document.getElementById('screenFps');
const screenCanvas = document.getElementById('screenCanvas');
const screenPlaceholder = document.getElementById('screenPlaceholder');

let screenMirroring = false;

screenMirror.onFps(fps => { screenFps.textContent = `${fps} FPS`; });
screenMirror.onError(msg => { screenFps.textContent = msg; });

function resizeScreenCanvas() {
  const container = document.querySelector('.screen-mirror-body');
  if (!container) return;
  const w = container.clientWidth - 32;
  const h = container.clientHeight - 32;
  let canvasW = Math.min(w, h * 2);
  let canvasH = canvasW / 2;
  if (canvasH > h) { canvasH = h; canvasW = canvasH * 2; }
  const scale = Math.max(1, Math.floor(canvasW / 128));
  screenCanvas.style.width = (128 * scale) + 'px';
  screenCanvas.style.height = (64 * scale) + 'px';
}

window.addEventListener('resize', () => { if (screenMirroring) resizeScreenCanvas(); });

function setScreenMirrorUI(active) {
  screenMirroring = active;
  screenStartBtn.disabled = active;
  screenStopBtn.disabled = !active;
  screenShotBtn.disabled = !active;
  screenStatusDot.className = 'status-dot' + (active ? ' connected' : '');
  screenStatusText.textContent = active ? 'Streaming (CLI paused)' : 'Stopped';
  if (!active) screenFps.textContent = '';
}

function saveScreenshot() {
  const dataUrl = screenCanvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `flipper_screen_${Date.now()}.png`;
  a.click();
  showToast('Screenshot saved', 'success');
}

async function startScreenMirror() {
  if (!connected) return;
  try {
    setScreenMirrorUI(true);
    screenCanvas.style.display = 'block';
    screenPlaceholder.style.display = 'none';
    resizeScreenCanvas();
    await screenMirror.start(screenCanvas);
  } catch (e) {
    setScreenMirrorUI(false);
    screenStatusText.textContent = `Error: ${e.message}`;
  }
}

async function stopScreenMirror() {
  screenStopBtn.disabled = true;
  screenStatusText.textContent = 'Restoring CLI...';
  try {
    await screenMirror.stop();
  } catch {}
  setScreenMirrorUI(false);
}

screenStartBtn.addEventListener('click', startScreenMirror);
screenStopBtn.addEventListener('click', stopScreenMirror);
screenShotBtn.addEventListener('click', saveScreenshot);

// ── Export / Import Libraries ──
window._exportLibrary = function(type) {
  const store = type === 'subghz' ? subghzStore : type === 'ir' ? irStore : type === 'nfc' ? nfcStore : rfidStore;
  const data = store.getAll();
  if (data.length === 0) { showToast('No signals to export', 'info'); return; }
  downloadJSON(type + '_library', { type, signals: data, exported: new Date().toISOString() });
  showToast(`Exported ${data.length} ${type} signal(s)`, 'success');
};

window._importLibrary = function(type) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const signals = json.signals;
      if (!Array.isArray(signals) || signals.length === 0) {
        showToast('No signals found in file', 'error');
        return;
      }
      const store = type === 'subghz' ? subghzStore : type === 'ir' ? irStore : type === 'nfc' ? nfcStore : rfidStore;
      const imported = store.importBulk(signals);
      showToast(`Imported ${imported.length} ${type} signal(s)`, 'success');
      if (type === 'subghz') loadSubghzLibrary();
      else if (type === 'ir') loadSavedSignals();
      else loadNfcRfidLibrary();
    } catch (e) {
      showToast(`Import failed: ${e.message}`, 'error');
    }
  };
  input.click();
};

// ── Keyboard Shortcuts ──
const TAB_ORDER = ['terminal', 'files', 'wifi', 'subghz', 'nfcrfid', 'ir', 'remote', 'screen'];

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '8') {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    if (idx < TAB_ORDER.length) {
      const tab = document.querySelector(`.tab[data-tab="${TAB_ORDER[idx]}"]`);
      if (tab) tab.click();
    }
    return;
  }
  if (e.ctrlKey && e.key === '/') {
    e.preventDefault();
    document.querySelector('.tab[data-tab="terminal"]').click();
    terminalInput.focus();
    return;
  }
  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    toggleConnect();
    return;
  }
});

// ── Init ──
document.getElementById('connectBtn').addEventListener('click', toggleConnect);
document.getElementById('refreshFilesBtn').addEventListener('click', () => loadDirectory(currentPath));

// Try auto-reconnect to previously granted port
(async () => {
  try {
    const ports = await navigator.serial.getPorts();
    const flipperPort = ports.find(p => {
      const info = p.getInfo();
      return info.usbVendorId === 0x0483 && info.usbProductId === 0x5740;
    });
    if (flipperPort) {
      await flipperPort.open({ baudRate: 230400 });
      flipper._port = flipperPort;
      flipper._startReadLoop();
      await new Promise(r => setTimeout(r, 300));
      flipper._flushBuffer();
      flipperPort.addEventListener('disconnect', () => {
        flipper._readLoopRunning = false;
        flipper._port = null;
        setConnected(false);
        appendTerminal('sys', 'Flipper disconnected.');
      });
      setConnected(true);
      appendTerminal('sys', 'Auto-reconnected to Flipper Zero');
      loadDirectory(currentPath);
      runQuickCommand(activeQuickCmd);
    }
  } catch {
    // No previously granted port or port in use — that's fine
  }
  updateMarauderStatus();
})();
