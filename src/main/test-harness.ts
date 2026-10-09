// Headless test harness for the desktop app (no display needed).
// Stubs the `electron` module, boots the real backend + static server,
// and drives the real outbox/import HTTP loop with fake vendor views.
//
// Run: npm test  (builds first, so this always exercises fresh output)
import Module from 'node:module';
import { createRequire } from 'node:module';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
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
const ipcListeners = new Map<string, (event: { sender: unknown; senderFrame?: unknown }, payload: unknown) => void>();
const ipcHandlers = new Map<string, (event: { sender: unknown; senderFrame?: unknown }, payload?: unknown) => unknown>();
const windows: Array<{ focused: number }> = [];
// Unique per run: the import store dedupes identical texts across runs.
const MARKER = `harness scraped line ${Date.now().toString(36)}`;

// Stub `electron` before the compiled main process module loads. The build
// output is CommonJS, so patching CJS resolution intercepts its require().
const stub = {
  app: { whenReady: async () => {}, on() {}, quit() {}, commandLine: { appendSwitch() {} } },
  BrowserWindow: class {
    focused = 0;
    webContents = {};
    constructor() { windows.push(this); }
    loadURL() {} on() {} isDestroyed() { return false; }
    focus() { this.focused++; }
  },
  BrowserView: class { setBounds() {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  ipcMain: {
    on(channel: string, listener: (event: { sender: unknown }, payload: unknown) => void) { ipcListeners.set(channel, listener); },
    handle(channel: string, handler: (event: { sender: unknown }, payload?: unknown) => unknown) { ipcHandlers.set(channel, handler); },
  },
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
      mainFrame: {},
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
  // 1. backend boots, health ok
  api.startProxy();
  await sleep(1500);
  let r = (await fetch(`${backend}/api/health`).then((x) => x.json())) as unknown;
  assert.deepStrictEqual(r, { ok: true }, 'backend health');
  console.log('ok  - backend boots + health');

  // 2. static server serves the panel and proxies /api
  api.startStatic();
  await sleep(500);
  const html = await fetch(`${panel}/`).then((x) => x.text());
  assert.ok(html.includes('blibs'), 'panel html served');
  r = await fetch(`${panel}/api/health`).then((x) => x.json());
  assert.deepStrictEqual(r, { ok: true }, 'static /api proxy');
  console.log('ok  - static panel + /api fan-out');

  // 3. outbox loop with a fake vendor view (no browser involved)
  await fetch(`${backend}/api/outbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'muse', text: 'hello desktop harness' }),
  });
  (api._views as Map<string, unknown>).set('muse', fakeView());
  api._sessions.set('muse', { provider: 'muse', state: 'ready', reason: 'Test session', updatedAt: Date.now(), lastSyncAt: null });
  const d = await api.drainOutbox('harness');
  assert.strictEqual(d.drained, 1, 'one item drained');
  const posted = sentToViews.find((s) => s.channel === 'blibs:send');
  assert.ok(posted && posted.msg.text === 'hello desktop harness', 'view received exact text');
  r = (await fetch(`${backend}/api/outbox`).then((x) => x.json())) as {
    items: Array<{ status: string }>;
  };
  assert.strictEqual(r.items[r.items.length - 1].status, 'sent', 'acked as sent');
  console.log('ok  - outbox enqueue -> view send -> ack');

  // 4. sweep relays scraped items into the import store
  (api._views as Map<string, unknown>).set('grok', fakeView());
  const s = await api.sweep('harness');
  assert.ok(s.added >= 1, 'sweep relayed items');
  r = (await fetch(`${backend}/api/imports`).then((x) => x.json())) as {
    imports: Array<{ text: string }>;
  };
  assert.ok(r.imports.some((m) => m.text === MARKER), 'import store has scrape');
  console.log('ok  - sweep collect -> import store');

  // Session expiry pauses delivery. Re-login resumes the same queue.
  api.wireIpc();
  const muse = api._views.get('muse')!;
  const museEvent = { sender: muse.webContents, senderFrame: muse.webContents.mainFrame };
  ipcListeners.get('blibs:session')!(museEvent, { state: 'signed-out', reason: 'Sign in.' });
  await fetch(`${backend}/api/outbox`, {
    method: 'POST', body: JSON.stringify({ provider: 'muse', text: 'after expiry' }),
  });
  const beforeExpiry = sentToViews.length;
  assert.strictEqual((await api.drainOutbox('expired')).drained, 0);
  assert.strictEqual(sentToViews.length, beforeExpiry, 'expired sessions do not receive sends');
  ipcListeners.get('blibs:session')!({ sender: {} }, { state: 'ready' });
  assert.strictEqual(api._sessions.get('muse')?.state, 'signed-out', 'unknown senders cannot change session state');
  ipcListeners.get('blibs:session')!(museEvent, { state: 'ready', reason: 'Signed in.' });
  await Promise.all([api.drainOutbox('resume'), api.drainOutbox('overlap')]);
  assert.strictEqual(sentToViews.filter((item) => item.msg.text === 'after expiry').length, 1, 'overlapping drains deliver once');
  console.log('ok  - session expiry, recovery, sender validation, and serialized delivery');

  api.openLogin('muse');
  api.openLogin('muse');
  assert.strictEqual(windows.length, 1, 'one sign-in window per vendor');
  assert.strictEqual(windows[0].focused, 1, 'repeated sign-in focuses the existing window');
  assert.throws(() => ipcHandlers.get('blibs:sign-in')!({ sender: {} }, 'muse'), /blibs panel/);
  console.log('ok  - sign-in window reuse and panel IPC protection');

  api.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  console.log('ALL DESKTOP HARNESS TESTS PASSED');
  process.exit(0);
} catch (e) {
  console.error('HARNESS FAILED:', e);
  try { api.shutdown(); } catch { /* ignore */ }
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
