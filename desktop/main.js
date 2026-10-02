// blibs desktop shell (Electron).
//
// What it is: the blibs panel + three persistent vendor sessions
// (muse.ai, chatgpt.com, grok.com) in ONE app. The vendor views stay alive
// inside the app — nothing needs to be open in your browser.
//
// How it works:
// - Spawns server/proxy.mjs (:8787) as a child process (import store + outbox).
// - Serves the built panel (../dist) on :5174, forwarding /api/* to :8787.
// - Keeps one hidden BrowserView per vendor (persisted partitions, so login
//   survives restarts) that scrapes chats and delivers outbox sends — the
//   same protocol as the browser extension, minus the browser.
// - Menu > Agents opens a login window per vendor (shared partition, so the
//   hidden view picks up the session automatically).
//
// Run: cd desktop && npm install && npm start   (requires `npm run build` first)
const { app, BrowserWindow, BrowserView, Menu, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PROXY_PORT = Number(process.env.PROXY_PORT || 8787);
const UI_PORT = Number(process.env.BLIBS_UI_PORT || 5173 + 1);
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PRELOAD = path.join(__dirname, 'preload-agent.js');

const VENDORS = [
  { id: 'muse', name: 'Muse', url: 'https://muse.ai/', partition: 'persist:muse' },
  { id: 'dots', name: 'Dots', url: 'https://chatgpt.com/', partition: 'persist:dots' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/', partition: 'persist:grok' },
];

// Container-friendly: Electron sandbox needs root setup we don't have here.
try {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    app.commandLine.appendSwitch('no-sandbox');
  }
} catch { /* ignore */ }

let proxyChild = null;
let staticServer = null;
let mainWin = null;
/** provider id -> BrowserView (hidden but alive) */
const views = new Map();
/** reqId -> resolve (main -> preload request/response) */
const pendingReqs = new Map();
let reqSeq = 0;

function proxyUrl(p) {
  return `http://127.0.0.1:${PROXY_PORT}${p}`;
}

async function proxyPost(p, body) {
  const res = await fetch(proxyUrl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `proxy HTTP ${res.status}`);
  return data;
}

async function proxyGet(p) {
  const res = await fetch(proxyUrl(p));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
  return data;
}

// ---------- child processes / servers ----------

function startProxy() {
  if (proxyChild) return proxyChild;
  proxyChild = spawn(process.execPath, [path.join(ROOT, 'server', 'proxy.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, PROXY_PORT: String(PROXY_PORT) },
  });
  proxyChild.on('exit', (code) => {
    console.error(`[blibs] proxy exited (${code})`);
    proxyChild = null;
  });
  return proxyChild;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function startStatic() {
  if (staticServer) return staticServer;
  staticServer = http.createServer((req, res) => {
    // API fan-out to the proxy (mirrors vite.config.ts in dev).
    if (req.url.startsWith('/api/')) {
      const target = proxyUrl(req.url);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const up = await fetch(target, {
            method: req.method,
            headers: { 'Content-Type': 'application/json' },
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          });
          const text = await up.text();
          res.writeHead(up.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(text);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `proxy unreachable: ${String(e)}` }));
        }
      });
      return;
    }
    let file = path.normalize(path.join(DIST, req.url.split('?')[0]));
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) file = path.join(DIST, 'index.html'); // SPA fallback
      fs.readFile(file, (err2, data) => {
        if (err2) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('blibs dist/ missing — run `npm run build` in the repo root first.');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
  });
  staticServer.listen(UI_PORT, '127.0.0.1', () => console.log(`[blibs] panel on http://127.0.0.1:${UI_PORT}`));
  return staticServer;
}

// ---------- windows & views ----------

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'blibs',
    backgroundColor: '#101216',
  });
  mainWin.loadURL(`http://127.0.0.1:${UI_PORT}/`);
  mainWin.on('closed', () => {
    mainWin = null;
  });
  return mainWin;
}

function attachVendorViews() {
  if (!mainWin) return;
  for (const v of VENDORS) {
    if (views.has(v.id)) continue;
    const view = new BrowserView({
      webPreferences: { preload: PRELOAD, partition: v.partition },
    });
    mainWin.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // hidden but alive
    view.webContents.loadURL(v.url);
    views.set(v.id, view);
  }
}

/** Visible login window sharing the hidden view's partition (same cookies). */
function openLogin(vendorId) {
  const v = VENDORS.find((x) => x.id === vendorId);
  if (!v) return;
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `${v.name} — log in`,
    backgroundColor: '#101216',
    webPreferences: { partition: v.partition },
  });
  win.loadURL(v.url);
}

function buildMenu() {
  const template = [
    {
      label: 'Agents',
      submenu: [
        ...VENDORS.map((v) => ({
          label: `Log in to ${v.name}…`,
          click: () => openLogin(v.id),
        })),
        { type: 'separator' },
        {
          label: 'Reload vendor views',
          click: () => {
            for (const view of views.values()) view.webContents.reload();
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- sync protocol (same as the extension, minus the browser) ----------

function askView(vendorId, channel, payload) {
  const view = views.get(vendorId);
  if (!view) return Promise.reject(new Error(`no view for ${vendorId}`));
  const reqId = `r${Date.now().toString(36)}${reqSeq++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReqs.delete(reqId);
      reject(new Error('view timeout (page still loading?)'));
    }, 20000);
    pendingReqs.set(reqId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    view.webContents.send(channel, { reqId, ...(payload || {}) });
  });
}

async function relayScrape(payload) {
  if (!payload?.items?.length) return { ok: false, reason: 'empty' };
  try {
    const data = await proxyPost('/api/import', { items: payload.items });
    return { ok: true, added: data.added ?? 0 };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** Backup sweep: collect from every view, then drain the outbox. */
async function sweep(reason) {
  let added = 0;
  for (const v of VENDORS) {
    try {
      const r = await askView(v.id, 'blibs:collect-now', {});
      if (r?.items?.length) {
        const posted = await relayScrape({ ...r, reason });
        added += posted.added ?? 0;
      }
    } catch { /* view not ready — next sweep */ }
  }
  await drainOutbox(reason);
  return { added };
}

/** Blibs -> tabs: type queued messages into the matching vendor view. */
async function drainOutbox(reason) {
  let pending = [];
  try {
    const data = await proxyGet('/api/outbox/pending');
    pending = data.items || [];
  } catch {
    return { drained: 0, error: 'proxy unreachable' };
  }
  let drained = 0;
  for (const item of pending.slice(0, 5)) {
    if (!views.has(String(item.provider || '').toLowerCase())) {
      await ackOutbox(item.id, false, `no view for provider "${item.provider}"`);
      continue;
    }
    try {
      const r = await askView(item.provider, 'blibs:send', { text: item.text });
      await ackOutbox(item.id, !!r?.ok, r?.ok ? undefined : r?.reason || 'view send failed');
      if (r?.ok) drained++;
    } catch (e) {
      await ackOutbox(item.id, false, `view not writable yet (${reason}): ${e?.message || e}`);
    }
  }
  return { drained };
}

async function ackOutbox(id, ok, error) {
  try {
    await proxyPost('/api/outbox/ack', { id, ok, error });
  } catch { /* ack lost — item stays queued, retried next sweep */ }
}

function wireIpc() {
  // Preload pushes (page load, DOM mutations, heartbeat).
  ipcMain.on('blibs:scrape', (_e, payload) => {
    relayScrape(payload).then(() => drainOutbox('scrape'));
  });
  // Preload answers to main-initiated requests.
  ipcMain.on('blibs:collect-result', (_e, msg) => {
    const done = pendingReqs.get(msg?.reqId);
    if (done) {
      pendingReqs.delete(msg.reqId);
      done(msg);
    }
  });
  ipcMain.on('blibs:send-result', (_e, msg) => {
    const done = pendingReqs.get(msg?.reqId);
    if (done) {
      pendingReqs.delete(msg.reqId);
      done(msg);
    }
  });
}

// ---------- lifecycle ----------

async function boot() {
  startProxy();
  // Give the proxy a moment before the panel (and sweeps) hit it.
  await new Promise((r) => setTimeout(r, 800));
  startStatic();
  wireIpc();
  createMainWindow();
  attachVendorViews();
  buildMenu();
  setInterval(() => sweep('sweep-60s').catch(() => {}), 60000);
  setInterval(() => drainOutbox('timer-30s').catch(() => {}), 30000);
}

async function smoke() {
  // --blibs-smoke: used to verify the shell where a display exists.
  await new Promise((r) => setTimeout(r, 4000));
  const report = { views: [...views.keys()], uiPort: UI_PORT, proxyPort: PROXY_PORT };
  try {
    await proxyGet('/api/health');
    report.proxy = 'ok';
  } catch (e) {
    report.proxy = `unreachable: ${String(e)}`;
  }
  console.log(`[blibs-smoke] ${JSON.stringify(report)}`);
  app.quit();
  if (!report.views.length || report.proxy !== 'ok') process.exitCode = 1;
}

if (!process.env.BLIBS_NO_AUTOSTART) {
  app.whenReady().then(() => {
    boot().then(() => {
      if (process.argv.includes('--blibs-smoke')) smoke();
    });
  });
  app.on('window-all-closed', () => {
    if (proxyChild) proxyChild.kill();
    if (staticServer) staticServer.close();
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    if (proxyChild) proxyChild.kill();
  });
}

// Exported for the headless test harness (BLIBS_NO_AUTOSTART=1).
function shutdown() {
  if (proxyChild) {
    proxyChild.kill();
    proxyChild = null;
  }
  if (staticServer) {
    staticServer.close();
    staticServer = null;
  }
}
module.exports = {
  VENDORS, PROXY_PORT, UI_PORT,
  startProxy, startStatic, sweep, drainOutbox, relayScrape, askView, shutdown,
  _views: views, _pending: pendingReqs,
};
