// Popup: list vendor tabs, trigger sync, show last-sync state.
// #result = outcome of the button you just pressed (never wiped).
// #status = persisted state from storage (survives popup close).
const PATTERNS = ['https://muse.ai/*', 'https://chatgpt.com/*', 'https://grok.com/*'];

function showResult(obj) {
  document.getElementById('result').textContent =
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1).slice(0, 900);
}

async function render() {
  const tabsEl = document.getElementById('tabs');
  const statusEl = document.getElementById('status');
  const tabs = await chrome.tabs.query({ url: PATTERNS });
  const state = await chrome.storage.local.get(['lastSyncAt', 'lastSyncAdded', 'lastSyncError', 'lastAttempt']);

  tabsEl.innerHTML = '';
  if (!tabs.length) {
    tabsEl.innerHTML = '<div class="row"><b>No vendor tabs open</b><span>open + log in first</span></div>';
  }
  for (const t of tabs) {
    const div = document.createElement('div');
    div.className = 'row';
    const name = new URL(t.url).hostname;
    div.innerHTML = `<b></b><span></span>`;
    div.querySelector('b').textContent = name;
    div.querySelector('span').textContent = t.title?.slice(0, 40) || '';
    const btn = document.createElement('button');
    btn.textContent = 'Sync';
    btn.onclick = async () => {
      showResult(`syncing ${name}…`);
      try {
        const r = await chrome.runtime.sendMessage({ type: 'BLIBS_SYNC_TAB', tabId: t.id });
        showResult(r);
      } catch (e) {
        showResult({ ok: false, reason: `background unreachable (reload the extension): ${e?.message || e}` });
      }
      render();
    };
    div.appendChild(btn);
    tabsEl.appendChild(div);
  }

  const when = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : 'never';
  let txt =
    `last sync: ${when}` +
    (state.lastSyncAdded != null ? ` · pushed ${state.lastSyncAdded}` : '') +
    (state.lastSyncError ? `\nerror: ${state.lastSyncError}` : '');
  if (state.lastAttempt) {
    const a = state.lastAttempt;
    txt += `\nlast attempt: ${new Date(a.at).toLocaleTimeString()} · ${a.tab || '?'} · selector "${a.selector || '?'}" · collected ${a.collected ?? '?'}` +
      (a.added != null ? ` · added ${a.added}` : '') +
      (a.error ? `\n  ↳ ${a.error}` : '');
  } else {
    txt += '\nlast attempt: none recorded — click a Sync button';
  }
  statusEl.textContent = txt;
}

document.getElementById('sync').onclick = async () => {
  showResult('syncing all open vendor tabs…');
  const tabs = await chrome.tabs.query({ url: PATTERNS });
  const per = [];
  for (const t of tabs) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'BLIBS_SYNC_TAB', tabId: t.id });
      per.push({ tab: new URL(t.url).hostname, ...r });
    } catch (e) {
      per.push({ tab: new URL(t.url).hostname, ok: false, reason: String(e?.message || e) });
    }
  }
  showResult(tabs.length ? per : 'no vendor tabs open');
  render();
};
document.getElementById('open').onclick = () => chrome.tabs.create({ url: 'http://localhost:5173/' });

(async () => {
  const { customProxyHost } = await chrome.storage.local.get(['customProxyHost']);
  if (customProxyHost) document.getElementById('host').value = customProxyHost;
})();
document.getElementById('saveHost').onclick = async () => {
  const v = document.getElementById('host').value.trim();
  if (v) await chrome.storage.local.set({ customProxyHost: v });
  else await chrome.storage.local.remove(['customProxyHost']);
  showResult(v ? `proxy host saved: ${v} (used from now on)` : 'proxy host cleared — back to localhost');
  render();
};

render();
