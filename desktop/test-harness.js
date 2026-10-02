// Headless test harness for desktop/main.js (no display needed).
// Stubs the `electron` module, boots the real proxy + static server,
// and drives the real outbox/import HTTP loop with fake vendor views.
const Module = require('node:module');
const assert = require('node:assert');

const sentToViews = [];
function fakeView() {
  return {
    webContents: {
      loadURL() {},
      send(channel, msg) {
        sentToViews.push({ channel, msg });
        const done = api._pending.get(msg.reqId);
        if (!done) return;
        if (channel === 'blibs:send') done({ reqId: msg.reqId, ok: true, method: 'test-button' });
        if (channel === 'blibs:collect-now') {
          done({
            reqId: msg.reqId, ok: true,
            items: [{ provider: 'grok', role: 'agent', text: 'harness scraped line', ts: Date.now() }],
            debug: { used: 'test' },
          });
        }
      },
    },
  };
}

const stub = {
  app: { whenReady: async () => {}, on() {}, quit() {}, commandLine: { appendSwitch() {} } },
  BrowserWindow: class { constructor() {} loadURL() {} on() {} },
  BrowserView: class { setBounds() {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  ipcMain: { on() {}, handle() {} },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return stub;
  return origLoad.call(this, req, ...rest);
};

process.env.BLIBS_NO_AUTOSTART = '1';
const api = require('./main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. proxy boots, health ok
  api.startProxy();
  await sleep(1500);
  let r = await fetch('http://127.0.0.1:8787/api/health').then((x) => x.json());
  assert.deepStrictEqual(r, { ok: true }, 'proxy health');
  console.log('ok  - proxy boots + health');

  // 2. static server serves the panel and proxies /api
  api.startStatic();
  await sleep(500);
  const html = await fetch('http://127.0.0.1:5174/').then((x) => x.text());
  assert.ok(html.includes('blibs'), 'panel html served');
  r = await fetch('http://127.0.0.1:5174/api/health').then((x) => x.json());
  assert.deepStrictEqual(r, { ok: true }, 'static /api proxy');
  console.log('ok  - static panel + /api fan-out');

  // 3. outbox loop with a fake vendor view (no browser involved)
  await fetch('http://127.0.0.1:8787/api/outbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'muse', text: 'hello desktop harness' }),
  });
  api._views.set('muse', fakeView());
  const d = await api.drainOutbox('harness');
  assert.strictEqual(d.drained, 1, 'one item drained');
  const posted = sentToViews.find((s) => s.channel === 'blibs:send');
  assert.ok(posted && posted.msg.text === 'hello desktop harness', 'view received exact text');
  r = await fetch('http://127.0.0.1:8787/api/outbox').then((x) => x.json());
  assert.strictEqual(r.items[r.items.length - 1].status, 'sent', 'acked as sent');
  console.log('ok  - outbox enqueue -> view send -> ack');

  // 4. sweep relays scraped items into the import store
  api._views.set('grok', fakeView());
  const s = await api.sweep('harness');
  assert.ok(s.added >= 1, 'sweep relayed items');
  r = await fetch('http://127.0.0.1:8787/api/imports').then((x) => x.json());
  assert.ok(r.imports.some((m) => m.text === 'harness scraped line'), 'import store has scrape');
  console.log('ok  - sweep collect -> import store');

  api.shutdown();
  console.log('ALL DESKTOP HARNESS TESTS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAILED:', e);
  try { api.shutdown(); } catch {}
  process.exit(1);
});
