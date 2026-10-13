// Real Electron renderer test. Run only with the synthetic demo environment documented in docs/conversation-search.md.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.BLIBS_NO_AUTOSTART = '1';
process.env.BLIBS_DEMO = '1';
const root = path.resolve(__dirname, '..');
process.env.BLIBS_DATA_DIR = path.join(root, '.demo-data');
process.env.PROXY_PORT = '4321';
process.env.BLIBS_UI_PORT = '4312';
const api = require('../build/main/index.js');
const evidenceDir = path.join(root, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(win, js, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await win.webContents.executeJavaScript(js)) return; await delay(150); }
  throw new Error(`Renderer condition timed out: ${js}`);
}
app.whenReady().then(async () => {
  let win;
  try {
    api.startProxy(); api.startStatic();
    win = api.createMainWindow();
    await until(win, 'Boolean(document.querySelector(".history-nav"))');
    await win.webContents.executeJavaScript('document.querySelector(".history-nav").click()');
    await until(win, 'Boolean(document.querySelector(".history-form input"))');
    await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('.history-form input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'What database stores Atlas conversation history?'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until(win, '!document.querySelector(".history-actions button").disabled');
    await win.webContents.executeJavaScript('document.querySelector(".history-actions button").click()');
    await until(win, 'document.querySelectorAll(".history-result").length > 0');
    await until(win, '!document.querySelector(".history-actions button").disabled');
    const searchText = await win.webContents.executeJavaScript('document.querySelector(".history-results").innerText');
    assert.match(searchText, /SQLite/);
    fs.writeFileSync(path.join(evidenceDir, 'desktop-search.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.querySelectorAll(".history-actions button")[1].click()');
    await until(win, 'Boolean(document.querySelector(".grounded-answer .citation"))', 90000);
    const answerText = await win.webContents.executeJavaScript('document.querySelector(".grounded-answer").innerText');
    assert.match(answerText, /Atlas stores conversation history in SQLite/);
    fs.writeFileSync(path.join(evidenceDir, 'desktop-answer.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.querySelector(".citation").click()');
    await until(win, 'Boolean(document.querySelector(".source-detail blockquote"))');
    const sourceText = await win.webContents.executeJavaScript('document.querySelector(".source-detail blockquote").innerText');
    assert.equal(sourceText, 'Atlas stores conversation history in SQLite on the local machine.');
    fs.writeFileSync(path.join(evidenceDir, 'desktop-source.png'), (await win.webContents.capturePage()).toPNG());
    const backend = 'http://127.0.0.1:4321';
    const outbox = await fetch(`${backend}/api/outbox`).then(r => r.json());
    assert.equal(outbox.items.length, 0);
    const index = await fetch(`${backend}/api/index`).then(r => r.json());
    const report = { ok: true, renderer: 'Electron 34 / React 19', uiPort: 4312, syntheticMessages: 35, steps: ['search returns SQLite passage', 'real local model selects grounded sentence', 'citation opens exact retained source', 'search/ask leave outbox empty'], index, answerText, sourceText, screenshots: ['desktop-search.png','desktop-answer.png','desktop-source.png'] };
    fs.writeFileSync(path.join(evidenceDir, 'desktop-demo.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (win) win.destroy(); await api.shutdown(); app.quit(); }
});
