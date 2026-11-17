// Headless test harness for the desktop app (no display needed).
// Stubs the `electron` module, boots the real backend + static server,
// and drives the real outbox/import HTTP loop with fake vendor views.
//
// Run: npm test  (builds first, so this always exercises fresh output)
import Module from 'node:module';
import { createRequire } from 'node:module';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type * as MainApi from './index.ts';

process.env.BLIBS_NO_AUTOSTART = '1';
const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-harness-'));
process.env.BLIBS_DATA_DIR = dataDir;
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
process.env.PROXY_PORT = String(await freePort());
process.env.BLIBS_UI_PORT = String(await freePort());
const backend = `http://127.0.0.1:${process.env.PROXY_PORT}`;
const panel = `http://127.0.0.1:${process.env.BLIBS_UI_PORT}`;

interface SentMsg {
  channel: string;
  msg: { reqId: string; text?: string; [key: string]: unknown };
}

const sentToViews: SentMsg[] = [];
const menuTemplates: unknown[][] = [];
// Unique per run: the import store dedupes identical texts across runs.
const MARKER = `harness scraped line ${Date.now().toString(36)}`;

// Stub `electron` before the compiled main process module loads. The build
// output is CommonJS, so patching CJS resolution intercepts its require().
const stub = {
  app: {
    whenReady: async () => {}, on() {}, quit() {}, commandLine: { appendSwitch() {} },
    name: 'Electron',
    setName(name: string) { this.name = name; },
    getName() { return this.name; },
    setAppUserModelId() {},
    setAboutPanelOptions() {},
    getVersion: () => '0.1.0',
    isPackaged: false,
    dock: { setIcon() {} },
  },
  BrowserWindow: class { loadURL() {} on() {} },
  BrowserView: class { setBounds() {} },
  Menu: {
    buildFromTemplate: (template: unknown[]) => {
      menuTemplates.push(template);
      return {};
    },
    setApplicationMenu() {},
  },
  ipcMain: { on() {}, handle() {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
};
const mod = Module as unknown as { _load: (...args: unknown[]) => unknown };
const origLoad = mod._load.bind(Module);
mod._load = function (req: unknown, ...rest: unknown[]): unknown {
  if (req === 'electron') return stub;
  return origLoad(req, ...rest);
};

const require = createRequire(import.meta.url);
const api = require('../../build/main/index.js') as typeof MainApi;

function fakeView(): unknown {
  return {
    webContents: {
      loadURL() {},
      send(channel: string, msg: SentMsg['msg']) {
        sentToViews.push({ channel, msg });
        const done = (api._pending as Map<string, (r: unknown) => void>).get(msg.reqId);
        if (!done) return;
        if (channel === 'blibs:send') done({ reqId: msg.reqId, ok: true, method: 'test-button' });
        if (channel === 'blibs:collect-now') {
          done({
            reqId: msg.reqId, ok: true,
            items: [{ provider: 'grok', role: 'agent', text: MARKER, ts: Date.now() }],
            debug: { used: 'test' },
          });
        }
      },
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

try {
  // 1. branding: app name, menu, About item, and the committed icon files
  assert.equal(api.APP_NAME, 'blibs', 'app name');
  assert.equal(stub.app.getName(), 'blibs', 'the app name is set before ready');
  api.buildMenu();
  const menu = menuTemplates.at(-1) as Array<{ label?: string }>;
  assert.ok(JSON.stringify(menu).includes('About blibs'), 'the menu has an About blibs item');
  if (process.platform === 'darwin') {
    assert.equal(menu[0]?.label, 'blibs', 'the menu bar shows blibs');
  }
  assert.ok(existsSync(api.APP_ICON_PNG), 'the window icon PNG exists');
  assert.ok(existsSync(api.APP_ICON_DOCK), 'the Dock icon PNG exists');
  assert.ok(existsSync(api.APP_ICON_ICNS), 'the macOS icon exists');
  console.log('ok  - app name, menu, About, and icon assets');

  // 2. backend boots, health ok
  api.startProxy();
  await sleep(1500);
  let r = (await fetch(`${backend}/api/health`).then((x) => x.json())) as unknown;
  assert.deepStrictEqual(r, { ok: true }, 'backend health');
  console.log('ok  - backend boots + health');

  // 3. static server serves the panel and proxies /api
  api.startStatic();
  await sleep(500);
  const html = await fetch(`${panel}/`).then((x) => x.text());
  assert.ok(html.includes('blibs'), 'panel html served');
  r = await fetch(`${panel}/api/health`).then((x) => x.json());
  assert.deepStrictEqual(r, { ok: true }, 'static /api proxy');
  console.log('ok  - static panel + /api fan-out');

  // 4. outbox loop with a fake vendor view (no browser involved)
  await fetch(`${backend}/api/outbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'muse', text: 'hello desktop harness' }),
  });
  (api._views as Map<string, unknown>).set('muse', fakeView());
  const d = await api.drainOutbox('harness');
  assert.strictEqual(d.drained, 1, 'one item drained');
  const posted = sentToViews.find((s) => s.channel === 'blibs:send');
  assert.ok(posted && posted.msg.text === 'hello desktop harness', 'view received exact text');
  r = (await fetch(`${backend}/api/outbox`).then((x) => x.json())) as {
    items: Array<{ status: string }>;
  };
  assert.strictEqual(r.items[r.items.length - 1].status, 'sent', 'acked as sent');
  console.log('ok  - outbox enqueue -> view send -> ack');

  // 5. sweep relays scraped items into the import store
  (api._views as Map<string, unknown>).set('grok', fakeView());
  const s = await api.sweep('harness');
  assert.ok(s.added >= 1, 'sweep relayed items');
  r = (await fetch(`${backend}/api/imports`).then((x) => x.json())) as {
    imports: Array<{ text: string }>;
  };
  assert.ok(r.imports.some((m) => m.text === MARKER), 'import store has scrape');
  console.log('ok  - sweep collect -> import store');

  await api.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  console.log('ALL DESKTOP HARNESS TESTS PASSED');
  process.exit(0);
} catch (e) {
  console.error('HARNESS FAILED:', e);
  try { await api.shutdown(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
