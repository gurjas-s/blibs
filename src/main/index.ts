// blibs desktop shell (Electron).
//
// What it is: the blibs panel + three persistent vendor sessions
// (muse.ai, chatgpt.com, grok.com) in ONE app. The vendor views stay alive
// inside the app — nothing needs to be open in your browser.
//
// How it works:
// - Spawns server/proxy (import store + outbox) as a child process.
// - Serves the built panel (dist/) over HTTP, forwarding /api/* to the proxy.
// - Keeps one hidden BrowserView per vendor (persisted partitions, so login
//   survives restarts) that scrapes chats and delivers outbox sends.
// - Menu > Agents opens a login window per vendor (shared partition, so the
//   hidden view picks up the session automatically).
//
// Run: npm install && npm run build && npm start
import { app, BrowserWindow, BrowserView, Menu, ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const PROXY_PORT = Number(process.env.PROXY_PORT || 8787);
export const UI_PORT = Number(process.env.BLIBS_UI_PORT || 5173 + 1);
const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const PRELOAD = path.join(__dirname, '..', 'preload', 'agent.js');
const PROXY_ENTRY = path.join(__dirname, '..', 'server', 'proxy.js');
if (process.env.BLIBS_DEMO === '1') app.setPath('userData', path.join(ROOT, '.demo-profile'));

interface Vendor {
  id: string;
  name: string;
  url: string;
  partition: string;
}

export const VENDORS: Vendor[] = [
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

let proxyChild: ChildProcess | null = null;
let proxySetupError = '';
let staticServer: http.Server | null = null;
let mainWin: BrowserWindow | null = null;
/** provider id -> BrowserView (hidden but alive) */
export const _views = new Map<string, BrowserView>();
/** reqId -> resolve (main -> preload request/response) */
export const _pending = new Map<string, (result: CollectResult | SendResult) => void>();
let reqSeq = 0;

interface ScrapeItem {
  provider?: unknown;
  role?: unknown;
  text?: unknown;
  ts?: unknown;
  url?: unknown;
}

interface CollectResult {
  reqId?: string;
  ok?: boolean;
  items?: ScrapeItem[];
  [key: string]: unknown;
}

interface SendResult {
  reqId?: string;
  ok?: boolean;
  reason?: string;
  [key: string]: unknown;
}

interface OutboxItem {
  id: string;
  provider: string;
  text: string;
}

function proxyUrl(p: string): string {
  return `http://127.0.0.1:${PROXY_PORT}${p}`;
}

async function proxyPost<T = Record<string, unknown>>(p: string, body: unknown): Promise<T> {
  const res = await fetch(proxyUrl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `proxy HTTP ${res.status}`);
  return data;
}

async function proxyGet<T = Record<string, unknown>>(p: string): Promise<T> {
  const res = await fetch(proxyUrl(p));
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
  return data;
}

// ---------- child processes / servers ----------

export function startProxy(): ChildProcess {
  if (proxyChild) return proxyChild;
  // Electron 34 embeds Node 20; the SQLite backend needs the documented Node 24 runtime.
  proxyChild = spawn(process.env.BLIBS_NODE_PATH || 'node', [PROXY_ENTRY], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PROXY_PORT: String(PROXY_PORT),
      BLIBS_DATA_DIR: process.env.BLIBS_DATA_DIR || path.join(app.getPath('userData'), 'history'),
      BLIBS_LEGACY_DIR: process.env.BLIBS_LEGACY_DIR || path.dirname(PROXY_ENTRY) },
  });
  proxyChild.on('error', (error) => {
    proxySetupError = `The history backend needs Node.js 24. Install it or set BLIBS_NODE_PATH to its executable. ${error.message}`;
    console.error(`[blibs] ${proxySetupError}`);
    proxyChild = null;
  });
  proxyChild.on('exit', (code) => {
    console.error(`[blibs] proxy exited (${code})`);
    proxyChild = null;
    if (code) proxySetupError = `The backend exited (${code}). Use Node.js 24; set BLIBS_NODE_PATH if it is not on PATH. Check the history schema and terminal output.`;
  });
  return proxyChild;
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function startStatic(): http.Server {
  if (staticServer) return staticServer;
  staticServer = http.createServer((req, res) => {
    const url = req.url || '/';
    const trustedOrigin = `http://127.0.0.1:${UI_PORT}`;
    if (req.headers.host !== `127.0.0.1:${UI_PORT}` || (req.headers.origin && req.headers.origin !== trustedOrigin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Untrusted panel origin or host.' })); return;
    }
    // API fan-out to the proxy (mirrors vite.config.ts in dev).
    if (url.startsWith('/api/')) {
      const target = proxyUrl(url);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const controller = new AbortController();
          res.once('close', () => { if (!res.writableEnded) controller.abort(); });
          try {
            const up = await fetch(target, {
              method: req.method,
              headers: { 'Content-Type': 'application/json' },
              body: chunks.length ? Buffer.concat(chunks) : undefined,
              signal: controller.signal,
            });
            const text = await up.text();
            res.writeHead(up.status, { 'Content-Type': 'application/json' });
            res.end(text);
          } catch (e) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: proxySetupError || `proxy unreachable: ${String(e)}` }));
          }
        })();
      });
      return;
    }
    let file = path.normalize(path.join(DIST, url.split('?')[0] || '/'));
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
          res.end('blibs dist/ missing — run `npm run build` first.');
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

export function createMainWindow(): BrowserWindow {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'blibs',
    backgroundColor: '#101216',
  });
  void mainWin.loadURL(`http://127.0.0.1:${UI_PORT}/`);
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const vendor = VENDORS.find(v => new URL(v.url).hostname === target.hostname);
      if (target.protocol === 'https:' && vendor && !target.username && !target.password) openLogin(vendor.id, target.href);
    } catch { /* Invalid source links do not open a window. */ }
    return { action: 'deny' };
  });
  mainWin.on('closed', () => {
    mainWin = null;
  });
  return mainWin;
}

function attachVendorViews(): void {
  if (!mainWin) return;
  for (const v of VENDORS) {
    if (_views.has(v.id)) continue;
    const view = new BrowserView({
      webPreferences: { preload: PRELOAD, partition: v.partition },
    });
    mainWin.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // hidden but alive
    void view.webContents.loadURL(v.url);
    _views.set(v.id, view);
  }
}

/** Visible login window sharing the hidden view's partition (same cookies). */
function openLogin(vendorId: string, source?: string): void {
  const v = VENDORS.find((x) => x.id === vendorId);
  if (!v) return;
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `${v.name} — log in`,
    backgroundColor: '#101216',
    webPreferences: { partition: v.partition },
  });
  void win.loadURL(source || v.url);
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Agents',
      submenu: [
        ...VENDORS.map((v) => ({
          label: `Log in to ${v.name}…`,
          click: () => openLogin(v.id),
        })),
        { type: 'separator' as const },
        {
          label: 'Reload vendor views',
          click: () => {
            for (const view of _views.values()) view.webContents.reload();
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

// ---------- sync protocol ----------

function askView(vendorId: string, channel: string, payload: Record<string, unknown>): Promise<CollectResult | SendResult> {
  const view = _views.get(vendorId);
  if (!view) return Promise.reject(new Error(`no view for ${vendorId}`));
  const reqId = `r${Date.now().toString(36)}${reqSeq++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(reqId);
      reject(new Error('view timeout (page still loading?)'));
    }, 20000);
    _pending.set(reqId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    view.webContents.send(channel, { reqId, ...(payload || {}) });
  });
}

export async function relayScrape(payload: CollectResult): Promise<{ ok: boolean; added?: number; reason?: string }> {
  if (!payload?.items?.length) return { ok: false, reason: 'empty' };
  try {
    const data = await proxyPost<{ added?: number }>('/api/import', { items: payload.items });
    return { ok: true, added: data.added ?? 0 };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message || e) };
  }
}

/** Backup sweep: collect from every view, then drain the outbox. */
export async function sweep(reason: string): Promise<{ added: number }> {
  let added = 0;
  for (const v of VENDORS) {
    try {
      const r = (await askView(v.id, 'blibs:collect-now', {})) as CollectResult;
      if (r?.items?.length) {
        const posted = await relayScrape({ ...r, reason });
        added += posted.added ?? 0;
      }
    } catch { /* view not ready — next sweep */ }
  }
  await drainOutbox(reason);
  return { added };
}

/** Blibs -> views: type queued messages into the matching vendor view. */
export async function drainOutbox(reason: string): Promise<{ drained: number; error?: string }> {
  let pending: OutboxItem[] = [];
  try {
    const data = await proxyGet<{ items?: OutboxItem[] }>('/api/outbox/pending');
    pending = data.items || [];
  } catch {
    return { drained: 0, error: 'proxy unreachable' };
  }
  let drained = 0;
  for (const item of pending.slice(0, 5)) {
    if (!_views.has(String(item.provider || '').toLowerCase())) {
      await ackOutbox(item.id, false, `no view for provider "${item.provider}"`);
      continue;
    }
    try {
      const r = (await askView(item.provider, 'blibs:send', { text: item.text })) as SendResult;
      await ackOutbox(item.id, !!r?.ok, r?.ok ? undefined : r?.reason || 'view send failed');
      if (r?.ok) drained++;
    } catch (e) {
      await ackOutbox(item.id, false, `view not writable yet (${reason}): ${(e as Error)?.message || e}`);
    }
  }
  return { drained };
}

async function ackOutbox(id: string, ok: boolean, error?: string): Promise<void> {
  try {
    await proxyPost('/api/outbox/ack', { id, ok, error });
  } catch { /* ack lost — item stays queued, retried next sweep */ }
}

function wireIpc(): void {
  // Preload pushes (page load, DOM mutations, heartbeat).
  ipcMain.on('blibs:scrape', (_e: IpcMainEvent, payload: CollectResult) => {
    void relayScrape(payload).then(() => drainOutbox('scrape'));
  });
  // Preload answers to main-initiated requests.
  ipcMain.on('blibs:collect-result', (_e: IpcMainEvent, msg: CollectResult) => {
    const done = _pending.get(msg?.reqId || '');
    if (done) {
      _pending.delete(msg.reqId as string);
      done(msg);
    }
  });
  ipcMain.on('blibs:send-result', (_e: IpcMainEvent, msg: SendResult) => {
    const done = _pending.get(msg?.reqId || '');
    if (done) {
      _pending.delete(msg.reqId as string);
      done(msg);
    }
  });
}

// ---------- lifecycle ----------

async function boot(): Promise<void> {
  startProxy();
  // Give the proxy a moment before the panel (and sweeps) hit it.
  await new Promise((r) => setTimeout(r, 800));
  startStatic();
  wireIpc();
  createMainWindow();
  if (process.env.BLIBS_DEMO !== '1') attachVendorViews();
  buildMenu();
  if (process.env.BLIBS_DEMO !== '1') {
    setInterval(() => sweep('sweep-60s').catch(() => {}), 60000);
    setInterval(() => drainOutbox('timer-30s').catch(() => {}), 30000);
  }
}

async function smoke(): Promise<void> {
  // --blibs-smoke: used to verify the shell where a display exists.
  await new Promise((r) => setTimeout(r, 4000));
  const report: { views: string[]; uiPort: number; proxyPort: number; proxy?: string } = {
    views: [..._views.keys()],
    uiPort: UI_PORT,
    proxyPort: PROXY_PORT,
  };
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
  void app.whenReady().then(() => {
    void boot().then(() => {
      if (process.argv.includes('--blibs-smoke')) void smoke();
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
export async function shutdown(): Promise<void> {
  const pending: Promise<void>[] = [];
  if (proxyChild) {
    const child = proxyChild;
    if (child.exitCode === null) pending.push(new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); }));
    proxyChild = null;
  }
  if (staticServer) {
    const server = staticServer;
    pending.push(new Promise<void>(resolve => server.close(() => resolve())));
    staticServer = null;
  }
  await Promise.all(pending);
}
