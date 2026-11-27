// blibs desktop shell (Electron).
//
// What it is: the blibs panel + three persistent vendor sessions
// (muse.ai, chatgpt.com, grok.com) in ONE app. The vendor views stay alive
// inside the app — nothing needs to be open in your browser.
//
// How it works:
// - Spawns server/proxy (import store + outbox) as a child process.
// - Serves the built panel (dist/) over HTTP, forwarding /api/* to the proxy.
// - Keeps one hidden vendor window per vendor (persisted partitions, so login
//   survives restarts) that scrapes chats and delivers outbox sends.
// - The panel shows provider websites in a WebContentsView in its center pane.
//   Each WebContentsView shares its persistent partition with the hidden sync view.
//
// Run: npm install && npm run build && npm start
import { app, WebContentsView, BrowserWindow, Menu, clipboard, ipcMain, nativeImage } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  beginVendorLogin,
  cancelVendorLogin,
  checkVendorLogin,
  getLoginStatus,
  MOCK_LOGIN,
  probeVendorLogin,
  setLoginStatusSink,
} from './login';

export const PROXY_PORT = Number(process.env.PROXY_PORT || 8787);
export const UI_PORT = Number(process.env.BLIBS_UI_PORT || 5173 + 1);
const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const PRELOAD = path.join(__dirname, '..', 'preload', 'agent.js');
const PANEL_PRELOAD = path.join(__dirname, '..', 'preload', 'panel.js');
const PROXY_ENTRY = path.join(__dirname, '..', 'server', 'proxy.js');
const PANEL_ORIGIN = `http://127.0.0.1:${UI_PORT}`;

// ---------- branding ----------

/** Name that the application menu and the About panel show. */
export const APP_NAME = 'blibs';

// A packager must copy `assets/` into the app resources. The dev paths point
// at the checkout, so `npm start` uses the same committed icon files.
const ASSET_DIR = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(ROOT, 'assets');
/** PNG for the window icon on Linux and Windows, and for the About panel. */
export const APP_ICON_PNG = path.join(ASSET_DIR, 'icons', '512.png');
/** PNG for the macOS Dock, at the largest committed size. */
export const APP_ICON_DOCK = path.join(ASSET_DIR, 'icons', '1024.png');
/** macOS bundle icon. A packager sets this as `CFBundleIconFile`. */
export const APP_ICON_ICNS = path.join(ASSET_DIR, 'blibs.icns');

/**
 * Set the app name and the About panel before the first window opens. The
 * name must be set before `ready`, or the menu bar keeps the Electron name.
 */
export function applyBranding(): void {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId('com.blibs.app');
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: `© ${new Date().getFullYear()} blibs contributors`,
    iconPath: APP_ICON_PNG,
  });
}

/** Use the committed icon in the macOS Dock. Other platforms read the window icon. */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const icon = nativeImage.createFromPath(APP_ICON_DOCK);
  if (icon.isEmpty()) {
    console.error(`[blibs] app icon missing at ${APP_ICON_DOCK}`);
    return;
  }
  app.dock.setIcon(icon);
}

applyBranding();

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
/** provider id -> hidden BrowserWindow (alive, real layout viewport) */
export const _views = new Map<string, BrowserWindow>();
/** provider id -> embedded website view shown in the center pane */
const providerPaneViews = new Map<string, WebContentsView>();
let activeProviderPane: string | null = null;
let providerPaneBounds: Electron.Rectangle | null = null;
/** True while the outbox types into a vendor view, so a refresh cannot interrupt it. */
let vendorSending = false;
/** True while one outbox drain owns the queue. */
let drainingOutbox = false;
/** True while one read-only vendor page is loading. */
let vendorRefreshing = false;
/** The provider view is refreshed on this interval to receive phone messages. */
const VENDOR_SYNC_MS = 60_000;
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
  threadId?: string;
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
    title: APP_NAME,
    icon: process.platform === 'darwin' ? undefined : APP_ICON_PNG,
    backgroundColor: '#101216',
    webPreferences: { preload: PANEL_PRELOAD },
  });
  void mainWin.loadURL(`http://127.0.0.1:${UI_PORT}/`);
  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('did-start-loading', detachProviderPane);
  mainWin.on('close', closeProviderPanes);
  mainWin.on('closed', () => {
    closeVendorViews();
    mainWin = null;
  });
  return mainWin;
}

function attachVendorViews(): void {
  // A hidden window keeps a real viewport, so the outbox send can find the composer.
  for (const v of VENDORS) {
    if (_views.has(v.id)) continue;
    const view = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      webPreferences: { preload: PRELOAD, partition: v.partition, backgroundThrottling: false },
    });
    void view.loadURL(v.url);
    _views.set(v.id, view);
  }
}

function detachProviderPane(): void {
  const view = activeProviderPane && providerPaneViews.get(activeProviderPane);
  if (view && mainWin && !mainWin.isDestroyed()) {
    const hadFocus = view.webContents.isFocused();
    mainWin.contentView.removeChildView(view);
    if (hadFocus) mainWin.webContents.focus();
  }
  activeProviderPane = null;
}

function closeProviderPanes(): void {
  detachProviderPane();
  for (const view of providerPaneViews.values()) {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  providerPaneViews.clear();
  providerPaneBounds = null;
}

function closeVendorViews(): void {
  for (const view of _views.values()) {
    const candidate = view as unknown as { isDestroyed?: () => boolean; destroy?: () => void };
    if (typeof candidate.isDestroyed === 'function' && candidate.isDestroyed()) continue;
    candidate.destroy?.();
  }
  _views.clear();
}

/** Read fresh vendor messages in a disposable window. */
async function refreshVendorView(providerId: string): Promise<void> {
  if (vendorSending || vendorRefreshing) return;
  const vendor = VENDORS.find((entry) => entry.id === providerId);
  const hidden = _views.get(providerId);
  if (!vendor || !hidden || hidden.isDestroyed()) return;
  let url = vendor.url;
  try {
    const current = hidden.webContents.getURL();
    if (current && current !== 'about:blank') url = current;
  } catch { /* keep the vendor root */ }

  const view = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    webPreferences: {
      preload: PRELOAD,
      partition: vendor.partition,
      backgroundThrottling: false,
      additionalArguments: providerId === 'muse' ? ['--blibs-muse-refresh'] : [],
    },
  });
  vendorRefreshing = true;
  let cleanup = (): void => {};
  try {
    if (providerId === 'muse') {
      await refreshMuseChats(view, vendor);
      return;
    }
    const scraped = new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        ipcMain.removeListener('blibs:scrape', onScrape);
        resolve();
      };
      const timer = setTimeout(finish, 15000);
      const onScrape = (event: IpcMainEvent): void => {
        if (event.sender === view.webContents) finish();
      };
      cleanup = finish;
      ipcMain.on('blibs:scrape', onScrape);
    });
    await view.loadURL(url);
    await scraped;
  } catch { /* the next pass retries */ }
  finally {
    cleanup();
    try { view.destroy(); } catch { /* already gone */ }
    vendorRefreshing = false;
  }
}

function askMuseRefresh(
  view: BrowserWindow, channel: string, replyChannel: string, payload: Record<string, unknown>,
): Promise<CollectResult | undefined> {
  const contents = view.webContents;
  const reqId = `muse-${reqSeq++}`;
  return new Promise((resolve) => {
    const finish = (result?: CollectResult): void => {
      clearTimeout(timer);
      ipcMain.removeListener(replyChannel, onReply);
      resolve(result);
    };
    const onReply = (event: IpcMainEvent, reply: CollectResult | null): void => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame || reply?.reqId !== reqId) return;
      finish(reply);
    };
    const timer = setTimeout(finish, 12000);
    ipcMain.on(replyChannel, onReply);
    try {
      contents.send(channel, { reqId, ...payload });
    } catch {
      finish();
    }
  });
}

async function refreshMuseChats(view: BrowserWindow, vendor: Vendor): Promise<void> {
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const read = async (url: string): Promise<void> => {
    await view.loadURL(url);
    const result = await askMuseRefresh(view, 'blibs:collect-now', 'blibs:collect-result', {});
    if (result?.url !== url || !Array.isArray(result.items)) return;
    await relayScrape(result);
    void drainOutbox('muse-refresh');
  };
  await read(vendor.url);
  const seen = new Set<string>();
  for (let index = 0; !view.isDestroyed(); index++) {
    const result = await askMuseRefresh(view, 'blibs:muse:open-side-chat', 'blibs:muse:side-chat', { index });
    const url = result?.url;
    if (typeof url !== 'string' || !isProviderSource(vendor, url) || !new URL(url).pathname.startsWith('/thread/')) break;
    if (seen.has(url)) continue;
    seen.add(url);
    // Reload the selected URL so the page reads messages sent from other devices.
    await read(url);
  }
}

/** Refresh the vendor pages that the relay reads. */
async function refreshRelayView(): Promise<void> {
  try {
    const status = await proxyGet<{ provider?: string }>('/api/relay');
    if (status.provider) await refreshVendorView(status.provider);
  } catch { /* next pass */ }
}

/** True only for the panel renderer that this process served. */
function isTrustedPanel(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const { sender, senderFrame } = event;
  return Boolean(sender === mainWin?.webContents && senderFrame
    && senderFrame === sender.mainFrame && isTrustedPanelUrl(senderFrame.url));
}

function isTrustedPanelUrl(url: string): boolean {
  try {
    return new URL(url).origin === PANEL_ORIGIN;
  } catch {
    return false;
  }
}

function vendorFor(vendorId: unknown): Vendor | undefined {
  if (typeof vendorId !== 'string') return undefined;
  return VENDORS.find((vendor) => vendor.id === vendorId);
}

function registerLoginIpc(): void {
  ipcMain.handle('blibs:login:open', (event, vendorId: unknown) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    const vendor = vendorFor(vendorId);
    if (!vendor) throw new Error('Unknown vendor.');
    return beginVendorLogin(vendor);
  });
  ipcMain.handle('blibs:login:cancel', (event, vendorId: unknown) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    const vendor = vendorFor(vendorId);
    if (!vendor) throw new Error('Unknown vendor.');
    return cancelVendorLogin(vendor);
  });
  ipcMain.handle('blibs:login:check', async (event, vendorId: unknown) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    const vendor = vendorFor(vendorId);
    if (!vendor) throw new Error('Unknown vendor.');
    return checkVendorLogin(vendor, providerPaneViews.get(vendor.id)?.webContents.getURL());
  });
  ipcMain.handle('blibs:login:status', (event, vendorId: unknown) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    const vendor = vendorFor(vendorId);
    if (!vendor) throw new Error('Unknown vendor.');
    return getLoginStatus(vendor.id);
  });
  ipcMain.handle('blibs:login:probe', async (event, vendorId: unknown) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    const vendor = vendorFor(vendorId);
    if (!vendor) throw new Error('Unknown vendor.');
    return probeVendorLogin(vendor);
  });
}

function registerClipboardIpc(): void {
  ipcMain.handle('blibs:clipboard:write', (event, value: unknown) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    if (typeof value !== 'string' || value.length > 1_000_000) {
      throw new Error('Invalid clipboard text.');
    }
    clipboard.writeText(value);
  });
}

function isProviderSource(vendor: Vendor, source: string): boolean {
  try {
    const url = new URL(source);
    return url.origin === new URL(vendor.url).origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

function registerProviderPaneIpc(): void {
  ipcMain.handle('blibs:provider-pane:show', async (event, providerId: unknown, source: unknown) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    const vendor = vendorFor(providerId);
    if (!vendor || !mainWin || mainWin.isDestroyed()) throw new Error('Unknown provider.');
    if (source !== undefined && (typeof source !== 'string' || !isProviderSource(vendor, source))) {
      throw new Error('Invalid provider thread URL.');
    }
    let view = providerPaneViews.get(vendor.id);
    if (!view) {
      view = new WebContentsView({
        webPreferences: {
          preload: PRELOAD,
          partition: vendor.partition,
          backgroundThrottling: false,
          additionalArguments: ['--blibs-provider-pane'],
        },
      });
      view.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const target = new URL(url);
          if (target.protocol === 'https:' && !target.username && !target.password) {
            void view?.webContents.loadURL(target.href).catch(() => undefined);
          }
        } catch { /* Ignore invalid URLs. */ }
        return { action: 'deny' };
      });
      view.webContents.on('will-navigate', (navigationEvent, url) => {
        try {
          const target = new URL(url);
          if (target.protocol !== 'https:' || target.username || target.password) {
            navigationEvent.preventDefault();
          }
        } catch { navigationEvent.preventDefault(); }
      });
      providerPaneViews.set(vendor.id, view);
    }
    detachProviderPane();
    activeProviderPane = vendor.id;
    mainWin.contentView.addChildView(view);
    if (providerPaneBounds) view.setBounds(providerPaneBounds);
    const contents = view.webContents;
    if (MOCK_LOGIN) {
      if (!contents.getURL() && !contents.isLoadingMainFrame()) {
        const markup = `<title>${vendor.name}</title><label>Message <textarea></textarea></label>`;
        await contents.loadURL(`data:text/html,${encodeURIComponent(markup)}`);
      }
    } else if (source !== undefined || !contents.getURL() || contents.getURL().startsWith('chrome-error:')) {
      await contents.loadURL(source ?? vendor.url);
    }
  });
  ipcMain.handle('blibs:provider-pane:hide', (event) => {
    if (!isTrustedPanel(event)) throw new Error('Untrusted panel sender.');
    detachProviderPane();
  });
  ipcMain.on('blibs:provider-pane:escape', (event) => {
    const view = activeProviderPane && providerPaneViews.get(activeProviderPane);
    if (!view || event.sender !== view.webContents || event.senderFrame !== event.sender.mainFrame) return;
    mainWin?.webContents.send('blibs:provider-pane:back');
  });
  ipcMain.on('blibs:provider-pane:bounds', (event, bounds: unknown) => {
    if (!isTrustedPanel(event)) return;
    if (!bounds || typeof bounds !== 'object') return;
    const rect = bounds as Partial<Electron.Rectangle>;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    const safeBounds: Electron.Rectangle = {
      x: Math.max(0, Math.round(rect.x as number)),
      y: Math.max(0, Math.round(rect.y as number)),
      width: Math.max(0, Math.round(rect.width as number)),
      height: Math.max(0, Math.round(rect.height as number)),
    };
    providerPaneBounds = safeBounds;
    if (activeProviderPane) providerPaneViews.get(activeProviderPane)?.setBounds(safeBounds);
  });
}

export function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') {
    // The first menu is the application menu. Its label is the name that the
    // menu bar shows, so set it in one place with the About item.
    template.push({
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    });
  }
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });
  template.push({
    label: 'Agents',
    submenu: [
      {
        label: 'Reload vendor views',
        click: () => { void refreshRelayView(); },
      },
    ],
  });
  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      ...(process.platform === 'darwin'
        ? []
        : [{ type: 'separator' as const }, { role: 'quit' as const }]),
    ],
  });
  if (process.platform !== 'darwin') {
    template.push({
      label: 'Help',
      submenu: [{ label: `About ${APP_NAME}`, click: () => app.showAboutPanel() }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- sync protocol ----------

/** The visible provider pane wins. The hidden view is the fallback. */
function activeView(provider: string, threadId?: string): BrowserWindow | WebContentsView | undefined {
  if (mainWin?.isFocused() && activeProviderPane === provider) {
    const pane = providerPaneViews.get(provider);
    const vendor = vendorFor(provider);
    const current = pane?.webContents.getURL();
    if (pane && vendor && current && !pane.webContents.isLoadingMainFrame()
      && new URL(current).origin === new URL(vendor.url).origin
      && (!threadId || current.split('#')[0] === threadId.split('#')[0])) return pane;
  }
  return _views.get(provider);
}

function askView(view: BrowserWindow | WebContentsView | undefined, channel: string, payload: Record<string, unknown>): Promise<CollectResult | SendResult> {
  if (!view) return Promise.reject(new Error('no view'));
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
      const r = (await askView(_views.get(v.id), 'blibs:collect-now', {})) as CollectResult;
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
  // More than one scrape, sweep, or timer can ask for a drain. Without this
  // lock two drains fetch the same queued item and type it twice.
  if (drainingOutbox) return { drained: 0 };
  drainingOutbox = true;
  try {
    let pending: OutboxItem[];
    try {
      const data = await proxyGet<{ items?: OutboxItem[] }>('/api/outbox/pending');
      pending = data.items || [];
    } catch {
      return { drained: 0, error: 'proxy unreachable' };
    }
    let drained = 0;
    vendorSending = true;
    try {
      for (const item of pending.slice(0, 5)) {
        const provider = String(item.provider || '').toLowerCase();
        const view = activeView(provider, item.threadId);
        if (!view) {
          await ackOutbox(item.id, false, `no view for provider "${item.provider}"`);
          continue;
        }
        try {
          await ensureThread(view, provider, item.threadId);
          const r = (await askView(view, 'blibs:send', { text: item.text })) as SendResult;
          await ackOutbox(item.id, !!r?.ok, r?.ok ? undefined : r?.reason || 'view send failed');
          if (r?.ok) drained++;
        } catch (e) {
          await ackOutbox(item.id, false, `view not writable yet (${reason}): ${(e as Error)?.message || e}`);
        }
      }
    } finally {
      vendorSending = false;
    }
    return { drained };
  } finally {
    drainingOutbox = false;
  }
}

// A reply belongs to one conversation. Move the hidden view to that thread
// before sending, so the message lands in the chat that mentioned @opencode.
// The vendor page mounts its composer after the load event, so the send waits.
const THREAD_SETTLE_MS = 2000;

async function ensureThread(view: BrowserWindow | WebContentsView, provider: string, threadId?: string): Promise<void> {
  if (!threadId) return;
  let target: URL;
  try {
    target = new URL(threadId);
  } catch {
    return;
  }
  if (target.protocol !== 'https:') return;
  const vendor = VENDORS.find((v) => v.id === provider);
  if (!vendor) return;
  let vendorHost: string;
  try {
    vendorHost = new URL(vendor.url).hostname;
  } catch {
    return;
  }
  if (target.hostname !== vendorHost) return;
  let current: string;
  try {
    current = view.webContents.getURL();
  } catch {
    return;
  }
  if (current.split('#')[0] === threadId.split('#')[0]) return;
  await view.webContents.loadURL(threadId);
  await new Promise((resolve) => setTimeout(resolve, THREAD_SETTLE_MS));
}

async function ackOutbox(id: string, ok: boolean, error?: string): Promise<void> {
  try {
    await proxyPost('/api/outbox/ack', { id, ok, error });
    console.info(JSON.stringify({ time: new Date().toISOString(), component: 'blibs-outbox', event: 'delivery-result', id, ok }));
  } catch {
    console.warn(JSON.stringify({ time: new Date().toISOString(), component: 'blibs-outbox', event: 'ack-failed', id }));
  }
}

function wireIpc(): void {
  registerLoginIpc();
  registerClipboardIpc();
  registerProviderPaneIpc();
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
  applyDockIcon();
  createMainWindow();
  setLoginStatusSink((status) => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('blibs:login:status', status);
    }
  });
  attachVendorViews();
  buildMenu();
  setInterval(() => sweep('sweep-60s').catch(() => {}), 60000);
  setInterval(() => drainOutbox('timer-30s').catch(() => {}), 30000);
  // The vendor page does not always receive another device's messages while it
  // stays open. Read it in a disposable window instead of reloading the view.
  setTimeout(() => {
    void refreshRelayView();
    setInterval(() => { void refreshRelayView(); }, VENDOR_SYNC_MS);
  }, 20000);
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
  closeProviderPanes();
  closeVendorViews();
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
