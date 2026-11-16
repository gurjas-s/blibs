const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const directory = process.env.BLIBS_TEST_DIR;
assert.ok(directory, 'Run this check with npm run test:desktop.');
fs.mkdirSync(path.join(directory, 'profile'));
app.setPath('userData', path.join(directory, 'profile'));
process.env.BLIBS_NO_AUTOSTART = '1';
process.env.BLIBS_DATA_DIR = path.join(directory, 'history');
process.env.BLIBS_LEGACY_DIR = directory;
delete process.env.BLIBS_EMBEDDING_URL;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Desktop condition timed out.');
}

async function run() {
  let api;
  let win;
  const quote = 'alpha record 0';
  // A fixed response tests the citation flow without a model download or quality claim.
  const generation = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const evidence = JSON.parse(request.messages[1].content).untrustedEvidence;
    const source = evidence.find(item => item.text === quote);
    res.setHeader('Content-Type', 'application/json');
    const claims = source ? [{ quote, sourceId: source.sourceId }] : [];
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims }) } }] }));
  });
  try {
    generation.listen(0, '127.0.0.1');
    await once(generation, 'listening');
    process.env.BLIBS_GENERATION_URL = `http://127.0.0.1:${generation.address().port}`;
    process.env.PROXY_PORT = String(await freePort());
    process.env.BLIBS_UI_PORT = String(await freePort());
    api = require('../build/main/index.js');
    await app.whenReady();
    api.startProxy();
    api.startStatic();
    const base = `http://127.0.0.1:${process.env.PROXY_PORT}`;
    await until(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } });
    const now = Date.now();
    const echo = 'delayed reply';
    const items = [
      { provider: 'dots', role: 'user', sourceId: 'old', text: echo, ts: now - 180000 },
      { provider: 'dots', role: 'user', sourceId: 'echo', text: echo, ts: now },
      { provider: 'dots', role: 'user', sourceId: 'repeat', text: echo, ts: now + 1 },
      ...['alpha', 'beta'].flatMap(word => Array.from({ length: 12 }, (_, index) => ({
        provider: 'dots', role: 'agent', sourceId: `${word}-${index}`, text: `${word} record ${index}`, ts: now + 10 + index,
      }))),
    ];
    const imported = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    assert.equal(imported.status, 200);
    win = new BrowserWindow({ show: false });
    const js = code => win.webContents.executeJavaScript(code);
    const waitFor = code => until(() => js(code));
    await win.loadURL(`http://127.0.0.1:${process.env.BLIBS_UI_PORT}/`);
    await js(`localStorage.setItem('blibs-messages-v2', JSON.stringify({dots:[{id:'outgoing',agentId:'dots',role:'user',text:'${echo}',ts:${now - 120000},source:'desktop',via:'tab',outStatus:'sent'}]})); localStorage.setItem('blibs-autopull-v1','false')`);
    const reloaded = once(win.webContents, 'did-finish-load');
    win.reload();
    await reloaded;
    await waitFor(`JSON.parse(localStorage.getItem('blibs-messages-v2')).dots.some(m => m.id === 'outgoing' && m.historyId)`);
    const messages = await js(`JSON.parse(localStorage.getItem('blibs-messages-v2')).dots`);
    assert.equal(messages.filter(message => message.text === echo).length, 3, 'Merge the delayed echo, but keep older and repeated messages.');
    const history = await fetch(`${base}/api/history`).then(res => res.json());
    assert.equal(messages.find(message => message.id === 'outgoing').historyId, history.items.find(message => message.sourceId === 'echo').id);

    await js(`document.querySelector('.history-nav').click()`);
    await waitFor(`Boolean(document.querySelector('.history-form input'))`);
    async function setQuery(value) {
      await js(`(() => { const input=document.querySelector('.history-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await waitFor(`document.querySelector('.history-form input').value === ${JSON.stringify(value)}`);
    }
    const submit = () => js(`document.querySelector('.history-form').requestSubmit()`);
    const next = `Array.from(document.querySelectorAll('.history-results button')).find(button => button.textContent === 'Next')`;
    await setQuery('alpha');
    await submit();
    await waitFor(`document.querySelectorAll('.history-result').length === 10 && !document.querySelector('.history-form button').disabled`);
    await js(`${next}.click()`);
    await waitFor(`document.querySelectorAll('.history-result').length === 2 && !document.querySelector('.history-form button').disabled`);
    await setQuery('beta');
    await waitFor(`document.querySelectorAll('.history-result').length === 0`);
    assert.equal(await js(`Boolean(${next})`), false, 'Changing the query removes old paging controls.');
    await submit();
    await waitFor(`document.querySelectorAll('.history-result').length === 10 && !document.querySelector('.history-form button').disabled`);
    assert.equal(await js(`document.querySelector('.history-result .result-thread + p').textContent`), 'beta record 0');
    await js(`(() => { const select=document.querySelector('.history-filters select'); select.value='grok'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await waitFor(`document.querySelectorAll('.history-result').length === 0`);
    await submit();
    await waitFor(`Boolean(document.querySelector('.history-results > p')) && !document.querySelector('.history-form button').disabled`);
    await js(`(() => { const select=document.querySelector('.history-filters select'); select.value=''; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await setQuery(quote);
    await waitFor(`!document.querySelectorAll('.history-form .history-actions button')[1].disabled`);
    await js(`document.querySelectorAll('.history-form .history-actions button')[1].click()`);
    await waitFor(`Boolean(document.querySelector('.citation'))`);
    await js(`document.querySelector('.citation').click()`);
    await waitFor(`Boolean(document.querySelector('.source-detail blockquote'))`);
    assert.equal(await js(`document.querySelector('.source-detail blockquote').innerText`), quote);
    const outbox = await fetch(`${base}/api/outbox`).then(res => res.json());
    assert.equal(outbox.items.length, 0, 'Search and answers must not queue messages.');
    console.log('Desktop search, paging, delayed echo, filters, and citation checks passed.');
  } finally {
    if (win) win.destroy();
    if (api) await api.shutdown();
    await new Promise(resolve => generation.close(resolve));
  }
}
run().then(() => app.quit(), error => { console.error(error); app.exit(1); });
