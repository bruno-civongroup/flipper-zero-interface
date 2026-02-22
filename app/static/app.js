// ── State ──
let connected = false;
let currentPath = "/ext";
let commandHistory = [];
let historyIndex = -1;
let ws = null;
let activeQuickCmd = "device_info";

// ── DOM refs ──
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const portSelect = document.getElementById("portSelect");
const connectBtn = document.getElementById("connectBtn");
const terminalOutput = document.getElementById("terminalOutput");
const terminalInput = document.getElementById("terminalInput");
const fileList = document.getElementById("fileList");
const breadcrumb = document.getElementById("breadcrumb");
const uploadZone = document.getElementById("uploadZone");
const fileInput = document.getElementById("fileInput");
const infoOutput = document.getElementById("infoOutput");
const infoPanelTitle = document.getElementById("infoPanelTitle");

// ── API helpers ──
async function api(path, opts = {}) {
    const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...opts,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Request failed");
    return data;
}

// ── Export helper ──
let lastScanData = null;
let lastScanType = null;

function exportScan(format) {
    if (!lastScanData || !lastScanType) return;
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/export/download";
    form.target = "_blank";
    // Use fetch + blob download instead of form for JSON body
    fetch("/api/export/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            scan_type: lastScanType,
            data: lastScanData,
            format: format,
        }),
    })
        .then((r) => r.blob())
        .then((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            a.download = `flipper_${lastScanType}_${ts}.${format === "csv" ? "csv" : "json"}`;
            a.click();
            URL.revokeObjectURL(url);
        });
}

function exportButtons() {
    return `<div style="margin-top: 10px; display: flex; gap: 6px;">
        <button class="btn btn-sm btn-primary" onclick="exportScan('json')">Export JSON</button>
        <button class="btn btn-sm btn-primary" onclick="exportScan('csv')">Export CSV</button>
    </div>`;
}

async function apiLong(path, opts = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(path, {
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            ...opts,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Request failed");
        return data;
    } finally {
        clearTimeout(timer);
    }
}

// ── Connection ──
function setConnected(state, port) {
    connected = state;
    statusDot.className = "status-dot" + (state ? " connected" : "");
    statusText.textContent = state ? `Connected (${port})` : "Disconnected";
    connectBtn.textContent = state ? "Disconnect" : "Connect";
    connectBtn.className = "btn " + (state ? "btn-danger" : "btn-primary");
    updateMarauderStatus();
}

async function refreshPorts() {
    try {
        const data = await api("/api/serial/ports");
        portSelect.innerHTML = '<option value="">-- Select Port --</option>';
        data.ports.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.device;
            opt.textContent = p.is_flipper
                ? `${p.device} (Flipper Zero)`
                : `${p.device} - ${p.description}`;
            if (p.is_flipper) opt.selected = true;
            portSelect.appendChild(opt);
        });
    } catch (e) {
        appendTerminal("err", `Failed to list ports: ${e.message}`);
    }
}

async function toggleConnect() {
    if (connected) {
        await api("/api/serial/disconnect", { method: "POST" });
        setConnected(false);
        appendTerminal("sys", "Disconnected.");
        disconnectWs();
        infoOutput.innerHTML = '<div class="info-placeholder">Connect to Flipper to view device info</div>';
    } else {
        try {
            const port = portSelect.value || undefined;
            const body = port ? JSON.stringify({ port }) : "{}";
            const data = await api("/api/serial/connect", {
                method: "POST",
                body,
            });
            setConnected(true, data.port);
            appendTerminal("sys", `Connected on ${data.port}`);
            connectWs();
            loadDirectory(currentPath);
            // Auto-load the active quick command
            runQuickCommand(activeQuickCmd);
        } catch (e) {
            appendTerminal("err", `Connection failed: ${e.message}`);
        }
    }
}

// ── WebSocket (live monitoring) ──
function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/monitor`);
    ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "status" && msg.connected && msg.info) {
            // Only auto-update if viewing device_info
            if (activeQuickCmd === "device_info") {
                renderInfoPanel("Device Info", msg.info);
            }
        }
    };
    ws.onclose = () => { ws = null; };
}

function disconnectWs() {
    if (ws) { ws.close(); ws = null; }
}

// ── Info Panel (swappable) ──
function renderInfoPanel(title, raw) {
    infoPanelTitle.textContent = title;

    // Parse key:value lines into a table
    const lines = raw.split("\n").filter((l) => l.trim());
    const pairs = [];
    for (const line of lines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
            const key = line.substring(0, colonIdx).trim();
            const val = line.substring(colonIdx + 1).trim();
            pairs.push([key, val]);
        } else {
            pairs.push([null, line.trim()]);
        }
    }

    // If most lines are key:value, render as table; otherwise render as raw
    const kvCount = pairs.filter(([k]) => k !== null).length;
    if (kvCount > lines.length * 0.5 && kvCount >= 2) {
        let html = '<table class="info-table">';
        for (const [key, val] of pairs) {
            if (key) {
                html += `<tr><td>${esc(key)}</td><td>${esc(val)}</td></tr>`;
            } else {
                html += `<tr><td colspan="2">${esc(val)}</td></tr>`;
            }
        }
        html += "</table>";
        infoOutput.innerHTML = html;
    } else {
        infoOutput.innerHTML = `<div class="info-raw">${esc(raw)}</div>`;
    }
}

function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

async function runQuickCommand(cmd) {
    if (!connected) {
        infoOutput.innerHTML = '<div class="info-placeholder">Connect to Flipper first</div>';
        return;
    }

    // Find the button and set loading state
    const btn = document.querySelector(`.btn-quick[data-cmd="${cmd}"]`);
    if (btn) btn.classList.add("loading");

    try {
        const data = await api("/api/serial/command", {
            method: "POST",
            body: JSON.stringify({ command: cmd }),
        });
        const label = btn ? btn.dataset.label : cmd;
        renderInfoPanel(label, data.response || "(no output)");
    } catch (e) {
        infoOutput.innerHTML = `<div class="info-raw" style="color: var(--red)">${esc(e.message)}</div>`;
    } finally {
        if (btn) btn.classList.remove("loading");
    }
}

// ── Quick command button clicks ──
document.querySelectorAll(".btn-quick").forEach((btn) => {
    btn.addEventListener("click", () => {
        // Update active state
        document.querySelectorAll(".btn-quick").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeQuickCmd = btn.dataset.cmd;
        runQuickCommand(activeQuickCmd);
    });
});

document.getElementById("refreshInfoBtn").addEventListener("click", () => {
    runQuickCommand(activeQuickCmd);
});

// ── Tabs ──
document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        const target = tab.dataset.tab;

        // Switch active tab
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");

        // Switch content
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        document.getElementById(`tab-${target}`).classList.add("active");

        // Switch tab-bar actions
        document.getElementById("clearTermBtn").style.display = target === "terminal" ? "inline" : "none";
        document.getElementById("refreshFilesBtn").style.display = target === "files" ? "inline" : "none";

        // Update marauder status when switching to WiFi tab
        if (target === "wifi") updateMarauderStatus();
        if (target === "ir") loadSavedSignals();

        if (target === "terminal") terminalInput.focus();
    });
});

// ── Terminal ──
function appendTerminal(type, text) {
    const div = document.createElement("div");
    div.className = type;
    div.textContent = text;
    terminalOutput.appendChild(div);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function clearTerminal() {
    terminalOutput.innerHTML = "";
}

document.getElementById("clearTermBtn").addEventListener("click", clearTerminal);

async function runCommand(cmd) {
    if (!cmd.trim()) return;
    appendTerminal("cmd", `> ${cmd}`);
    commandHistory.unshift(cmd);
    historyIndex = -1;

    try {
        const data = await api("/api/serial/command", {
            method: "POST",
            body: JSON.stringify({ command: cmd }),
        });
        appendTerminal("resp", data.response || "(no output)");
    } catch (e) {
        appendTerminal("err", e.message);
    }
}

terminalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        runCommand(terminalInput.value);
        terminalInput.value = "";
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIndex < commandHistory.length - 1) {
            historyIndex++;
            terminalInput.value = commandHistory[historyIndex];
        }
    } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex > 0) {
            historyIndex--;
            terminalInput.value = commandHistory[historyIndex];
        } else {
            historyIndex = -1;
            terminalInput.value = "";
        }
    }
});

// ── File Browser ──
function renderBreadcrumb(path) {
    const parts = path.split("/").filter(Boolean);
    let html = '<a onclick="loadDirectory(\'/\')">root</a>';
    let cumulative = "";
    parts.forEach((p) => {
        cumulative += "/" + p;
        const full = cumulative;
        html += ` / <a onclick="loadDirectory('${full}')">${p}</a>`;
    });
    breadcrumb.innerHTML = html;
}

async function loadDirectory(path) {
    currentPath = path;
    renderBreadcrumb(path);

    try {
        const data = await api(`/api/files/list?path=${encodeURIComponent(path)}`);
        fileList.innerHTML = "";

        if (path !== "/" && path !== "/ext") {
            const parentPath = path.substring(0, path.lastIndexOf("/")) || "/";
            const li = document.createElement("li");
            li.innerHTML = '<span class="icon">..</span> <span>Parent Directory</span>';
            li.onclick = () => loadDirectory(parentPath);
            fileList.appendChild(li);
        }

        data.entries.forEach((entry) => {
            const li = document.createElement("li");
            const icon = entry.type === "directory" ? "\u{1F4C1}" : "\u{1F4C4}";
            const size = entry.size != null ? `<span class="size">${formatSize(entry.size)}</span>` : "";
            li.innerHTML = `<span class="icon">${icon}</span> <span>${esc(entry.name)}</span>${size}`;

            if (entry.type === "directory") {
                li.onclick = () => loadDirectory(`${path}/${entry.name}`.replace("//", "/"));
            } else {
                li.onclick = () => viewFile(`${path}/${entry.name}`.replace("//", "/"));
            }
            fileList.appendChild(li);
        });

        if (data.entries.length === 0) {
            fileList.innerHTML = '<li style="color: var(--text-dim)">Empty directory</li>';
        }
    } catch (e) {
        fileList.innerHTML = `<li style="color: var(--red)">${esc(e.message)}</li>`;
    }
}

async function viewFile(path) {
    appendTerminal("sys", `Reading file: ${path}`);
    try {
        const data = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
        appendTerminal("resp", data.content || "(empty file)");
        // Switch to terminal tab to show file content
        document.querySelector('.tab[data-tab="terminal"]').click();
    } catch (e) {
        appendTerminal("err", e.message);
    }
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── File Upload ──
uploadZone.addEventListener("click", () => fileInput.click());
uploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadZone.classList.add("dragover");
});
uploadZone.addEventListener("dragleave", () => {
    uploadZone.classList.remove("dragover");
});
uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadZone.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => {
    uploadFiles(fileInput.files);
    fileInput.value = "";
});

async function uploadFiles(files) {
    for (const file of files) {
        const dest = `${currentPath}/${file.name}`.replace("//", "/");
        appendTerminal("sys", `Uploading ${file.name} to ${dest}...`);
        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch(`/api/files/upload?path=${encodeURIComponent(dest)}`, {
                method: "POST",
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail);
            appendTerminal("resp", `Uploaded ${file.name} (${formatSize(data.size)})`);
        } catch (e) {
            appendTerminal("err", `Upload failed: ${e.message}`);
        }
    }
    loadDirectory(currentPath);
}

// ── WiFi Scanner (Marauder) ──
const marauderStatusDot = document.getElementById("marauderStatusDot");
const marauderStatusText = document.getElementById("marauderStatusText");
const scanApBtn = document.getElementById("scanApBtn");
const scanStaBtn = document.getElementById("scanStaBtn");
const stopScanBtn = document.getElementById("stopScanBtn");
const wifiResults = document.getElementById("wifiResults");

function updateMarauderStatus() {
    // Bridge mode: WiFi scanning works as long as the Flipper is connected
    const ready = connected;
    marauderStatusDot.className = "status-dot" + (ready ? " connected" : "");
    marauderStatusText.textContent = ready
        ? "Bridge via Flipper UART"
        : "Connect Flipper first";
}

async function scanAccessPoints() {
    wifiResults.innerHTML = '<div class="scan-status"><span class="spinner"></span> Scanning for access points... (~7 seconds)</div>';
    scanApBtn.disabled = true;
    scanStaBtn.disabled = true;

    try {
        const data = await apiLong("/api/wifi/scan/ap", { method: "POST" }, 30000);
        lastScanType = "wifi_ap";
        lastScanData = data;
        renderApTable(data.access_points, data.raw);
    } catch (e) {
        wifiResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Scan failed: ${esc(e.message)}</div>`;
    } finally {
        scanApBtn.disabled = false;
        scanStaBtn.disabled = false;
    }
}

async function scanStations() {
    wifiResults.innerHTML = '<div class="scan-status"><span class="spinner"></span> Scanning for client stations... (~10 seconds)</div>';
    scanApBtn.disabled = true;
    scanStaBtn.disabled = true;

    try {
        const data = await apiLong("/api/wifi/scan/station", { method: "POST" }, 30000);
        lastScanType = "wifi_sta";
        lastScanData = data;
        renderStationTable(data.stations, data.raw);
    } catch (e) {
        wifiResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Scan failed: ${esc(e.message)}</div>`;
    } finally {
        scanApBtn.disabled = false;
        scanStaBtn.disabled = false;
    }
}

async function stopScan() {
    try {
        await api("/api/wifi/scan/stop", { method: "POST" });
    } catch (e) {
        console.error("Stop scan failed:", e);
    }
}

function rssiToBar(rssi) {
    if (rssi === null || rssi === undefined) return "";
    const abs = Math.abs(rssi);
    // Map RSSI: -30 (best) to -90 (worst) → 100% to 0%
    const pct = Math.max(0, Math.min(100, ((90 - abs) / 60) * 100));
    let cls = "rssi-weak";
    if (pct > 75) cls = "rssi-excellent";
    else if (pct > 50) cls = "rssi-good";
    else if (pct > 25) cls = "rssi-fair";
    return `<span class="rssi-bar ${cls}" style="width: ${Math.max(4, pct * 0.8)}px"></span> ${rssi}dBm`;
}

function renderApTable(aps, raw) {
    if (aps.length === 0) {
        wifiResults.innerHTML = `<div class="info-placeholder">No access points found.</div>
            <details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
                <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
                <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre>
            </details>`;
        return;
    }

    // Sort by RSSI (strongest first)
    aps.sort((a, b) => (b.rssi || -100) - (a.rssi || -100));

    let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">${aps.length} network(s) found</div>`;
    html += `<table class="ap-table">
        <thead><tr>
            <th>#</th>
            <th>SSID</th>
            <th>Signal</th>
            <th>CH</th>
            <th>BSSID</th>
            <th>Security</th>
        </tr></thead><tbody>`;

    aps.forEach((ap, i) => {
        html += `<tr>
            <td>${i + 1}</td>
            <td class="ssid">${esc(ap.ssid || "(hidden)")}</td>
            <td>${rssiToBar(ap.rssi)}</td>
            <td>${ap.channel || "--"}</td>
            <td class="bssid">${esc(ap.bssid)}</td>
            <td>${esc(ap.encryption)}</td>
        </tr>`;
    });

    html += `</tbody></table>`;
    html += exportButtons();
    html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
        <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
        <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre>
    </details>`;

    wifiResults.innerHTML = html;
}

function renderStationTable(stations, raw) {
    if (stations.length === 0) {
        wifiResults.innerHTML = `<div class="info-placeholder">No stations found.</div>
            <details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
                <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
                <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre>
            </details>`;
        return;
    }

    let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">${stations.length} station(s) found</div>`;
    html += `<table class="ap-table">
        <thead><tr>
            <th>#</th>
            <th>MAC Address</th>
            <th>Details</th>
        </tr></thead><tbody>`;

    stations.forEach((s, i) => {
        html += `<tr>
            <td>${i + 1}</td>
            <td class="bssid">${esc(s.mac)}</td>
            <td>${esc(s.raw)}</td>
        </tr>`;
    });

    html += `</tbody></table>`;
    html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
        <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
        <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(raw)}</pre>
    </details>`;

    wifiResults.innerHTML = html;
}

// ── Raw Marauder command ──
const marauderRawInput = document.getElementById("marauderRawInput");
const marauderRawBtn = document.getElementById("marauderRawBtn");

async function sendRawMarauder() {
    const cmd = marauderRawInput.value.trim();
    if (!cmd) return;

    wifiResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Sending: ${esc(cmd)}...</div>`;
    marauderRawBtn.disabled = true;

    try {
        const data = await apiLong("/api/wifi/scan/raw", {
            method: "POST",
            body: JSON.stringify({ command: cmd, wait_ms: 3000 }),
        }, 20000);
        wifiResults.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">
            Command: <span style="color: var(--orange);">${esc(cmd)}</span>
        </div>
        <pre style="white-space: pre-wrap; font-size: 12px; color: var(--text); line-height: 1.6;">${esc(data.response)}</pre>`;
    } catch (e) {
        wifiResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">${esc(e.message)}</div>`;
    } finally {
        marauderRawBtn.disabled = false;
    }
}

marauderRawBtn.addEventListener("click", sendRawMarauder);
marauderRawInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendRawMarauder();
});

// ── Sub-GHz Scanner ──
const subghzFreqSelect = document.getElementById("subghzFreqSelect");
const subghzDuration = document.getElementById("subghzDuration");
const subghzListenBtn = document.getElementById("subghzListenBtn");
const subghzListenRawBtn = document.getElementById("subghzListenRawBtn");
const subghzResults = document.getElementById("subghzResults");

async function subghzListen(raw = false) {
    const freq = parseInt(subghzFreqSelect.value);
    const dur = parseInt(subghzDuration.value);
    const freqMhz = (freq / 1_000_000).toFixed(2);
    const endpoint = raw ? "/api/subghz/listen/raw" : "/api/subghz/listen";

    subghzResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Listening on ${freqMhz} MHz for ${dur} seconds...</div>`;
    subghzListenBtn.disabled = true;
    subghzListenRawBtn.disabled = true;

    try {
        const data = await apiLong(endpoint, {
            method: "POST",
            body: JSON.stringify({ frequency: freq, duration: dur, device: 0 }),
        }, (dur + 10) * 1000);

        if (raw) {
            renderSubghzRaw(data);
        } else {
            lastScanType = "subghz";
            lastScanData = data;
            renderSubghzSignals(data);
        }
    } catch (e) {
        subghzResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Listen failed: ${esc(e.message)}</div>`;
    } finally {
        subghzListenBtn.disabled = false;
        subghzListenRawBtn.disabled = false;
    }
}

function renderSubghzSignals(data) {
    const freqMhz = data.frequency_mhz.toFixed(2);
    let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
        Listened on ${freqMhz} MHz for ${data.duration}s &mdash; ${data.count} signal(s) captured
    </div>`;

    if (data.signals.length === 0) {
        html += `<div class="no-signals">
            No decoded signals captured during the listen window.<br>
            <span style="font-size: 11px; color: var(--text-dim);">Try pressing a remote, doorbell, or other device while listening.</span>
        </div>`;
    } else {
        data.signals.forEach((sig, i) => {
            html += `<div class="signal-card">
                <div class="signal-protocol">${esc(sig.protocol)}</div>
                <div class="signal-details">`;
            if (sig.bits) html += `<div><span class="label">Bits:</span> <span class="value">${sig.bits}</span></div>`;
            if (sig.key) html += `<div><span class="label">Key:</span> <span class="signal-key">${esc(sig.key)}</span></div>`;
            if (sig.te) html += `<div><span class="label">TE:</span> <span class="value">${sig.te} \u00b5s</span></div>`;
            html += `</div></div>`;
        });
    }

    html += exportButtons();

    html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
        <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
        <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(data.raw)}</pre>
    </details>`;

    subghzResults.innerHTML = html;
}

function renderSubghzRaw(data) {
    const freqMhz = data.frequency_mhz.toFixed(2);
    subghzResults.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
        RAW listen on ${freqMhz} MHz for ${data.duration}s
    </div>
    <pre style="white-space: pre-wrap; font-size: 12px; color: var(--text-dim); line-height: 1.6;">${esc(data.raw)}</pre>`;
}

subghzListenBtn.addEventListener("click", () => subghzListen(false));
subghzListenRawBtn.addEventListener("click", () => subghzListen(true));

// ── NFC / RFID Scanner ──
const nfcrfidMode = document.getElementById("nfcrfidMode");
const nfcrfidDuration = document.getElementById("nfcrfidDuration");
const nfcrfidScanBtn = document.getElementById("nfcrfidScanBtn");
const nfcrfidResults = document.getElementById("nfcrfidResults");

async function nfcrfidScan() {
    const mode = nfcrfidMode.value;
    const dur = parseInt(nfcrfidDuration.value);
    const modeLabel = mode === "nfc" ? "NFC (13.56 MHz)" : "RFID (125 kHz)";

    nfcrfidResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Scanning ${modeLabel} for ${dur} seconds... Hold tag/card against Flipper.</div>`;
    nfcrfidScanBtn.disabled = true;

    try {
        let data;
        if (mode === "nfc") {
            data = await apiLong("/api/nfc/scan", {
                method: "POST",
                body: JSON.stringify({ duration: dur }),
            }, (dur + 15) * 1000);
            lastScanType = "nfc";
            lastScanData = data;
            renderNfcResults(data);
        } else {
            const rfidMode = mode === "rfid_indala" ? "indala" : "normal";
            data = await apiLong("/api/rfid/read", {
                method: "POST",
                body: JSON.stringify({ duration: dur, mode: rfidMode }),
            }, (dur + 10) * 1000);
            lastScanType = "rfid";
            lastScanData = data;
            renderRfidResults(data);
        }
    } catch (e) {
        nfcrfidResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Scan failed: ${esc(e.message)}</div>`;
    } finally {
        nfcrfidScanBtn.disabled = false;
    }
}

function renderNfcResults(data) {
    let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
        NFC scan (${data.duration}s) &mdash; ${data.count} tag(s) found
    </div>`;

    if (data.tags.length === 0) {
        html += `<div class="no-signals">
            No NFC tags detected.<br>
            <span style="font-size: 11px;">Hold the tag flat against the back of the Flipper during the scan.</span>
        </div>`;
    } else {
        data.tags.forEach((tag) => {
            html += `<div class="tag-card">
                <div class="tag-type">${esc(tag.type || tag.protocol || "NFC Tag")}</div>
                <div class="tag-uid">${esc(tag.uid || "Unknown UID")}</div>
                <div class="tag-details">`;
            if (tag.atqa) html += `<div><span class="label">ATQA:</span> <span class="value">${esc(tag.atqa)}</span></div>`;
            if (tag.sak) html += `<div><span class="label">SAK:</span> <span class="value">${esc(tag.sak)}</span></div>`;
            if (tag.protocol) html += `<div><span class="label">Protocol:</span> <span class="value">${esc(tag.protocol)}</span></div>`;
            html += `</div></div>`;
        });
    }

    html += exportButtons();

    html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
        <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
        <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(data.raw)}</pre>
    </details>`;

    nfcrfidResults.innerHTML = html;
}

function renderRfidResults(data) {
    let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
        RFID ${data.mode} scan (${data.duration}s) &mdash; ${data.count} card(s) read
    </div>`;

    if (data.cards.length === 0) {
        html += `<div class="no-signals">
            No RFID cards detected.<br>
            <span style="font-size: 11px;">Hold the card against the back of the Flipper during the scan.</span>
        </div>`;
    } else {
        data.cards.forEach((card) => {
            html += `<div class="tag-card" style="border-left-color: var(--orange);">
                <div class="tag-type" style="color: var(--orange);">${esc(card.protocol || "RFID Card")}</div>`;
            if (card.id) html += `<div class="tag-uid">${esc(card.id)}</div>`;
            if (card.data) html += `<div class="tag-uid">${esc(card.data)}</div>`;
            html += `<div class="tag-details">`;
            if (card.facility_code) html += `<div><span class="label">Facility Code:</span> <span class="value">${esc(card.facility_code)}</span></div>`;
            if (card.card_number) html += `<div><span class="label">Card Number:</span> <span class="value">${esc(card.card_number)}</span></div>`;
            html += `</div></div>`;
        });
    }

    html += exportButtons();

    html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
        <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
        <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(data.raw)}</pre>
    </details>`;

    nfcrfidResults.innerHTML = html;
}

nfcrfidScanBtn.addEventListener("click", nfcrfidScan);

scanApBtn.addEventListener("click", scanAccessPoints);
scanStaBtn.addEventListener("click", scanStations);
stopScanBtn.addEventListener("click", stopScan);

// ── Infrared ──
const irLearnBtn = document.getElementById("irLearnBtn");
const irTransmitBtn = document.getElementById("irTransmitBtn");
const irResults = document.getElementById("irResults");
const irMode = document.getElementById("irMode");
const irDuration = document.getElementById("irDuration");
const irProtocol = document.getElementById("irProtocol");
const irAddress = document.getElementById("irAddress");
const irCommand = document.getElementById("irCommand");
const irUniversalType = document.getElementById("irUniversalType");
const irUniversalButtons = document.getElementById("irUniversalButtons");

const universalButtonMap = {
    tv: ["power", "vol_up", "vol_down", "ch_up", "ch_down", "mute"],
    ac: ["off", "cool_hi", "cool_lo", "heat_hi", "heat_lo", "dh"],
    audio: ["power", "vol_up", "vol_down", "mute", "next", "prev"],
};

function renderUniversalButtons() {
    const type = irUniversalType.value;
    const buttons = universalButtonMap[type] || [];
    irUniversalButtons.innerHTML = buttons
        .map((b) => `<button class="btn btn-sm btn-primary" onclick="sendUniversalIR('${type}','${b}')">${b.replace(/_/g, " ")}</button>`)
        .join("");
}

irUniversalType.addEventListener("change", renderUniversalButtons);
renderUniversalButtons();

async function irLearn() {
    const mode = irMode.value;
    const dur = parseInt(irDuration.value);
    const endpoint = mode === "raw" ? "/api/ir/learn/raw" : "/api/ir/learn";

    irResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Learning IR signal for ${dur} seconds... Point a remote at the Flipper.</div>`;
    irLearnBtn.disabled = true;

    try {
        const data = await apiLong(endpoint, {
            method: "POST",
            body: JSON.stringify({ duration: dur }),
        }, (dur + 10) * 1000);

        if (mode === "raw") {
            irResults.innerHTML = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
                RAW IR capture (${data.duration}s)
            </div>
            <pre style="white-space: pre-wrap; font-size: 12px; color: var(--text-dim); line-height: 1.6;">${esc(data.raw)}</pre>`;
        } else {
            renderIrSignals(data);
        }
    } catch (e) {
        irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Learn failed: ${esc(e.message)}</div>`;
    } finally {
        irLearnBtn.disabled = false;
    }
}

function renderIrSignals(data) {
    let html = `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
        IR learn (${data.duration}s) &mdash; ${data.count} signal(s) captured
    </div>`;

    if (data.signals.length === 0) {
        html += `<div class="no-signals">
            No decoded IR signals captured.<br>
            <span style="font-size: 11px; color: var(--text-dim);">Point a remote directly at the Flipper's IR receiver and press a button during the learn window.</span>
        </div>`;
    } else {
        // Deduplicate: skip repeats, keep only unique protocol+address+command
        const seen = new Set();
        const unique = data.signals.filter((sig) => {
            if (sig.repeat) return false;
            const key = `${sig.protocol}|${sig.address}|${sig.command}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        unique.forEach((sig, i) => {
            const sigJson = JSON.stringify({ protocol: sig.protocol, address: sig.address || "", command: sig.command || "" });
            html += `<div class="signal-card">
                <div class="signal-protocol">${esc(sig.protocol)}</div>
                <div class="signal-details">`;
            if (sig.address) html += `<div><span class="label">Address:</span> <span class="signal-key">${esc(sig.address)}</span></div>`;
            if (sig.command) html += `<div><span class="label">Command:</span> <span class="signal-key">${esc(sig.command)}</span></div>`;
            html += `</div>
                <div style="margin-top: 8px; display: flex; gap: 6px; align-items: center;">
                    <button class="btn btn-sm btn-primary" onclick="fillIrTransmit('${esc(sig.protocol)}','${esc(sig.address || "")}','${esc(sig.command || "")}')">Use for Transmit</button>
                    <input type="text" class="port-select" id="irSaveName${i}" placeholder="Name (e.g. TV Power)" style="width: 160px; min-width: 100px; margin-bottom: 0; padding: 4px 8px; font-size: 12px;">
                    <button class="btn btn-sm btn-primary" onclick="saveIrSignal(${i}, ${esc(sigJson)})">Save</button>
                </div>
            </div>`;
        });

        if (unique.length < data.signals.length) {
            html += `<div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">${data.signals.length - unique.length} repeat(s) filtered</div>`;
        }
    }

    html += `<details style="margin-top: 12px; font-size: 12px; color: var(--text-dim);">
        <summary style="cursor: pointer; color: var(--orange);">Raw output</summary>
        <pre style="white-space: pre-wrap; margin-top: 8px;">${esc(data.raw)}</pre>
    </details>`;

    irResults.innerHTML = html;
}

async function saveIrSignal(index, sigData) {
    const nameInput = document.getElementById(`irSaveName${index}`);
    const name = nameInput ? nameInput.value.trim() : "";
    if (!name) {
        nameInput.style.borderColor = "var(--red)";
        nameInput.focus();
        return;
    }

    try {
        await api("/api/ir/signals", {
            method: "POST",
            body: JSON.stringify({
                name,
                protocol: sigData.protocol,
                address: sigData.address,
                command: sigData.command,
            }),
        });
        nameInput.style.borderColor = "var(--green)";
        nameInput.value = "Saved!";
        nameInput.disabled = true;
        loadSavedSignals();
    } catch (e) {
        nameInput.style.borderColor = "var(--red)";
    }
}

async function loadSavedSignals() {
    const container = document.getElementById("irSavedSignals");
    try {
        const data = await api("/api/ir/signals");
        if (data.signals.length === 0) {
            container.innerHTML = '<div style="color: var(--text-dim); font-size: 12px; padding: 8px;">No saved signals yet. Capture a signal and click Save.</div>';
            return;
        }
        let html = "";
        data.signals.forEach((sig) => {
            html += `<div class="saved-signal">
                <button class="btn btn-sm btn-primary saved-signal-play" onclick="replaySignal('${sig.id}')" title="Transmit">&#9654;</button>
                <div class="saved-signal-info">
                    <span class="saved-signal-name">${esc(sig.name)}</span>
                    <span class="saved-signal-detail">${esc(sig.protocol)} ${esc(sig.address)} ${esc(sig.command)}</span>
                </div>
                <button class="btn btn-sm btn-danger" onclick="deleteSignal('${sig.id}')" title="Delete">&times;</button>
            </div>`;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div style="color: var(--red); font-size: 12px; padding: 8px;">${esc(e.message)}</div>`;
    }
}

async function replaySignal(id) {
    try {
        const data = await api(`/api/ir/signals/${id}/transmit`, { method: "POST" });
        // Brief flash feedback on the button
        const btn = document.querySelector(`[onclick="replaySignal('${id}')"]`);
        if (btn) {
            btn.textContent = "\u2713";
            setTimeout(() => { btn.innerHTML = "&#9654;"; }, 600);
        }
    } catch (e) {
        alert(`Transmit failed: ${e.message}`);
    }
}

async function deleteSignal(id) {
    try {
        await api(`/api/ir/signals/${id}`, { method: "DELETE" });
        loadSavedSignals();
    } catch (e) {
        alert(`Delete failed: ${e.message}`);
    }
}

// ── IRDB Browser ──
const irdbOverlay = document.getElementById("irdbOverlay");
const irdbBody = document.getElementById("irdbBody");
const irdbBreadcrumb = document.getElementById("irdbBreadcrumb");
let irdbCurrentPath = "";

document.getElementById("irdbOpenBtn").addEventListener("click", () => {
    irdbOverlay.style.display = "flex";
    irdbBrowse("");
});

document.getElementById("irdbCloseBtn").addEventListener("click", () => {
    irdbOverlay.style.display = "none";
});

irdbOverlay.addEventListener("click", (e) => {
    if (e.target === irdbOverlay) irdbOverlay.style.display = "none";
});

function irdbRenderBreadcrumb(path) {
    let html = '<a onclick="irdbBrowse(\'\')">IRDB</a>';
    if (path) {
        const parts = path.split("/");
        let cumulative = "";
        parts.forEach((p) => {
            cumulative += (cumulative ? "/" : "") + p;
            const full = cumulative;
            html += ` / <a onclick="irdbBrowse('${full}')">${p}</a>`;
        });
    }
    irdbBreadcrumb.innerHTML = html;
}

async function irdbBrowse(path) {
    irdbCurrentPath = path;
    irdbRenderBreadcrumb(path);
    irdbBody.innerHTML = '<div class="scan-status"><span class="spinner"></span> Loading...</div>';

    try {
        const data = await api(`/api/ir/irdb/browse?path=${encodeURIComponent(path)}`);
        if (data.children.length === 0) {
            irdbBody.innerHTML = '<div class="info-placeholder">Empty directory</div>';
            return;
        }
        let html = "";
        data.children.forEach((item) => {
            if (item.type === "directory") {
                const full = path ? path + "/" + item.name : item.name;
                html += `<div class="irdb-item" onclick="irdbBrowse('${full}')">
                    <span class="icon">\u{1F4C1}</span>
                    <span>${esc(item.name.replace(/_/g, " "))}</span>
                </div>`;
            } else {
                const full = path ? path + "/" + item.name : item.name;
                const sizeStr = item.size ? `${(item.size / 1024).toFixed(1)} KB` : "";
                html += `<div class="irdb-item" onclick="irdbOpenFile('${full}')">
                    <span class="icon">\u{1F4E1}</span>
                    <span>${esc(item.name.replace(/_/g, " ").replace(".ir", ""))}</span>
                    <span class="size">${sizeStr}</span>
                </div>`;
            }
        });
        irdbBody.innerHTML = html;
    } catch (e) {
        irdbBody.innerHTML = `<div class="info-placeholder" style="color: var(--red)">${esc(e.message)}</div>`;
    }
}

async function irdbOpenFile(path) {
    irdbRenderBreadcrumb(path);
    irdbBody.innerHTML = '<div class="scan-status"><span class="spinner"></span> Fetching signals...</div>';

    try {
        const data = await api(`/api/ir/irdb/file?path=${encodeURIComponent(path)}`);
        const parsed = data.signals.filter((s) => s.type === "parsed");
        const raw = data.signals.filter((s) => s.type === "raw");

        let html = `<div style="font-size: 12px; color: var(--text-dim); padding: 4px 12px; margin-bottom: 4px;">
            ${data.count} signal(s) &mdash; ${parsed.length} decoded, ${raw.length} raw
        </div>`;

        if (parsed.length > 0) {
            html += `<div style="padding: 4px 12px; margin-bottom: 4px;">
                <label style="font-size: 12px; cursor: pointer; color: var(--text-dim);">
                    <input type="checkbox" id="irdbSelectAll" onchange="irdbToggleAll(this.checked)" checked> Select all decoded
                </label>
            </div>`;
            parsed.forEach((sig, i) => {
                html += `<div class="irdb-signal">
                    <input type="checkbox" class="irdb-check" data-index="${i}" checked>
                    <span class="sig-name">${esc(sig.name)}</span>
                    <span class="sig-detail">${esc(sig.protocol)} ${esc(sig.address)} ${esc(sig.command)}</span>
                </div>`;
            });
        }

        if (raw.length > 0) {
            html += `<div style="padding: 8px 12px; margin-top: 8px; font-size: 11px; color: var(--text-dim);">
                ${raw.length} raw signal(s) (not importable — raw timing data without decoded protocol)
            </div>`;
            raw.forEach((sig) => {
                html += `<div class="irdb-signal" style="opacity: 0.5;">
                    <span class="sig-name">${esc(sig.name)}</span>
                    <span class="sig-raw-tag">raw ${sig.frequency ? sig.frequency + " Hz" : ""}</span>
                </div>`;
            });
        }

        if (parsed.length > 0) {
            html += `<div class="irdb-actions">
                <button class="btn btn-sm btn-primary" onclick="irdbImportSelected()">Import Selected</button>
                <span id="irdbImportStatus" style="font-size: 12px; color: var(--text-dim);"></span>
            </div>`;
        }

        irdbBody.innerHTML = html;
        // Store parsed signals for import
        irdbBody._parsedSignals = parsed;
    } catch (e) {
        irdbBody.innerHTML = `<div class="info-placeholder" style="color: var(--red)">${esc(e.message)}</div>`;
    }
}

function irdbToggleAll(checked) {
    document.querySelectorAll(".irdb-check").forEach((cb) => { cb.checked = checked; });
}

async function irdbImportSelected() {
    const parsed = irdbBody._parsedSignals || [];
    const checks = document.querySelectorAll(".irdb-check");
    const selected = [];
    checks.forEach((cb) => {
        if (cb.checked) {
            const sig = parsed[parseInt(cb.dataset.index)];
            if (sig) selected.push({ name: sig.name, protocol: sig.protocol, address: sig.address, command: sig.command });
        }
    });

    if (selected.length === 0) return;

    const status = document.getElementById("irdbImportStatus");
    status.textContent = "Importing...";

    try {
        const data = await api("/api/ir/irdb/import", {
            method: "POST",
            body: JSON.stringify({ signals: selected }),
        });
        status.style.color = "var(--green)";
        status.textContent = `Imported ${data.imported} signal(s)`;
        loadSavedSignals();
    } catch (e) {
        status.style.color = "var(--red)";
        status.textContent = `Failed: ${e.message}`;
    }
}

function fillIrTransmit(protocol, address, command) {
    for (const opt of irProtocol.options) {
        if (opt.value === protocol) { opt.selected = true; break; }
    }
    irAddress.value = address;
    irCommand.value = command;
}

async function irTransmit() {
    const protocol = irProtocol.value;
    const address = irAddress.value.trim();
    const command = irCommand.value.trim();

    if (!address || !command) {
        irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Enter address and command values</div>`;
        return;
    }

    irTransmitBtn.disabled = true;
    irResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Transmitting IR: ${protocol} ${address} ${command}...</div>`;

    try {
        const data = await api("/api/ir/transmit", {
            method: "POST",
            body: JSON.stringify({ protocol, address, command }),
        });
        irResults.innerHTML = `<div class="signal-card">
            <div class="signal-protocol">Transmitted</div>
            <div class="signal-details">
                <div><span class="label">Protocol:</span> <span class="value">${esc(data.protocol)}</span></div>
                <div><span class="label">Address:</span> <span class="signal-key">${esc(data.address)}</span></div>
                <div><span class="label">Command:</span> <span class="signal-key">${esc(data.command)}</span></div>
            </div>
        </div>`;
    } catch (e) {
        irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Transmit failed: ${esc(e.message)}</div>`;
    } finally {
        irTransmitBtn.disabled = false;
    }
}

async function sendUniversalIR(remoteType, button) {
    irResults.innerHTML = `<div class="scan-status"><span class="spinner"></span> Sending ${remoteType} ${button.replace(/_/g, " ")}...</div>`;

    try {
        const data = await api("/api/ir/universal", {
            method: "POST",
            body: JSON.stringify({ remote_type: remoteType, button }),
        });
        irResults.innerHTML = `<div class="signal-card">
            <div class="signal-protocol">Universal: ${esc(data.remote_type)} &mdash; ${esc(data.button.replace(/_/g, " "))}</div>
            <div style="font-size: 12px; color: var(--text-dim); margin-top: 6px;">${esc(data.result || "Sent")}</div>
        </div>`;
    } catch (e) {
        irResults.innerHTML = `<div class="info-placeholder" style="color: var(--red)">Universal failed: ${esc(e.message)}</div>`;
    }
}

irLearnBtn.addEventListener("click", irLearn);
irTransmitBtn.addEventListener("click", irTransmit);

// ── Remote Control (D-pad) ──
const remoteLog = document.getElementById("remoteLog");

function logRemote(msg) {
    const div = document.createElement("div");
    div.textContent = msg;
    remoteLog.prepend(div);
    // Keep only last 20 entries
    while (remoteLog.children.length > 20) remoteLog.lastChild.remove();
}

document.querySelectorAll(".dpad-btn").forEach((btn) => {
    const key = btn.dataset.key;
    let pressTimer = null;
    let pressStart = 0;
    let sent = false;

    function startPress(e) {
        e.preventDefault();
        btn.classList.add("pressed");
        pressStart = Date.now();
        sent = false;
    }

    async function endPress(e) {
        e.preventDefault();
        btn.classList.remove("pressed");
        if (sent) return;
        sent = true;
        const elapsed = Date.now() - pressStart;
        const pressType = elapsed >= 500 ? "long" : "short";
        logRemote(`${key} (${pressType})`);

        try {
            await api("/api/input/send", {
                method: "POST",
                body: JSON.stringify({ key, type: pressType }),
            });
        } catch (e) {
            logRemote(`Error: ${e.message}`);
        }
    }

    // Mouse events
    btn.addEventListener("mousedown", startPress);
    btn.addEventListener("mouseup", endPress);
    btn.addEventListener("mouseleave", (e) => {
        if (pressStart && !sent) endPress(e);
    });

    // Touch events (mobile)
    btn.addEventListener("touchstart", startPress, { passive: false });
    btn.addEventListener("touchend", endPress, { passive: false });
    btn.addEventListener("touchcancel", endPress, { passive: false });
});

// ── Screen Mirror ──
const screenStartBtn = document.getElementById("screenStartBtn");
const screenStopBtn = document.getElementById("screenStopBtn");
const screenStatusDot = document.getElementById("screenStatusDot");
const screenStatusText = document.getElementById("screenStatusText");
const screenFps = document.getElementById("screenFps");
const screenCanvas = document.getElementById("screenCanvas");
const screenPlaceholder = document.getElementById("screenPlaceholder");
const screenCtx = screenCanvas.getContext("2d");
let screenWs = null;

screenCtx.imageSmoothingEnabled = false;

let screenMirroring = false;

function setScreenMirrorUI(active) {
    screenMirroring = active;
    screenStartBtn.disabled = active;
    screenStopBtn.disabled = !active;
    screenStatusDot.className = "status-dot" + (active ? " connected" : "");
    screenStatusText.textContent = active ? "Streaming (CLI paused)" : "Stopped";
    if (!active) screenFps.textContent = "";
}

function startScreenMirror() {
    if (screenWs) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    screenWs = new WebSocket(`${proto}://${location.host}/ws/screen`);

    screenWs.onopen = () => {
        screenWs.send(JSON.stringify({ action: "start" }));
        setScreenMirrorUI(true);
        screenCanvas.style.display = "block";
        screenPlaceholder.style.display = "none";
    };

    screenWs.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);

        if (msg.type === "frame") {
            const img = new Image();
            img.onload = () => {
                screenCtx.imageSmoothingEnabled = false;
                screenCtx.drawImage(img, 0, 0, 512, 256);
            };
            img.src = "data:image/png;base64," + msg.data;
            if (msg.fps !== undefined) {
                screenFps.textContent = `${msg.fps} FPS`;
            }
        } else if (msg.type === "error") {
            screenFps.textContent = msg.message;
        } else if (msg.type === "status" && !msg.streaming) {
            // Server confirmed stop — now safe to close WebSocket
            screenWs.close();
        }
    };

    screenWs.onclose = () => {
        screenWs = null;
        setScreenMirrorUI(false);
    };

    screenWs.onerror = () => {
        screenWs = null;
        setScreenMirrorUI(false);
        screenStatusText.textContent = "Error";
    };
}

function stopScreenMirror() {
    if (screenWs && screenWs.readyState === WebSocket.OPEN) {
        screenStopBtn.disabled = true;
        screenStatusText.textContent = "Restoring CLI...";
        screenWs.send(JSON.stringify({ action: "stop" }));
        // WebSocket closes in onmessage after server confirms stop
    }
}

screenStartBtn.addEventListener("click", startScreenMirror);
screenStopBtn.addEventListener("click", stopScreenMirror);

// ── Init ──
document.getElementById("refreshPortsBtn").addEventListener("click", refreshPorts);
document.getElementById("connectBtn").addEventListener("click", toggleConnect);
document.getElementById("refreshFilesBtn").addEventListener("click", () => loadDirectory(currentPath));

(async () => {
    await refreshPorts();
    const status = await api("/api/serial/status");
    if (status.connected) {
        setConnected(true, "auto");
        connectWs();
        loadDirectory(currentPath);
        runQuickCommand(activeQuickCmd);
    }
    updateMarauderStatus();
})();
