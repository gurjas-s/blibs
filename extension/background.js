// blibs companion — background service worker (MV3).
// Receives scraped chats from content.js and POSTs them to the blibs proxy
// (/api/import). Everything stays on your own machines.
//
// IMPORTANT — which proxy?
// The extension runs in YOUR Mac browser, so "localhost" means YOUR MAC.
// If `npm run proxy` runs on the VM instead, the extension must point at the
// VM's address (edit BLIBS_PROXY_HOSTS below, or set a custom host in the
// popup — stored in chrome.storage). The blibs frontend you click
// "Pull from extension" in must read from that SAME proxy, otherwise the
// inbox will look empty.
const DEFAULT_PROXY_HOSTS = [
  'http://127.0.0.1:8787', // proxy on the same machine as the browser (recommended)
  'http://localhost:8787',
  'http://192.168.5.15:8787', // this VM (edit to your VM's IP if it changes)
];

async function importUrls() {
  try {
    const { customProxyHost } = await chrome.storage.local.get(['customProxyHost']);
    if (customProxyHost) return [`http://${customProxyHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/import`];
  } catch { /* ignore */ }
  return DEFAULT_PROXY_HOSTS.map((h) => `${h}/api/import`);
}

async function postImport(items) {
  if (!items?.length) return { ok: false, reason: 'empty' };
  let lastErr = '';
  for (const url of await importUrls()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const at = Date.now();
        await chrome.storage.local.set({ lastSyncAt: at, lastSyncCount: items.length, lastSyncAdded: data.added ?? 0 });
        return { ok: true, added: data.added ?? 0, total: data.total ?? 0 };
      }
      lastErr = data?.error || `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }
  await chrome.storage.local.set({ lastSyncError: lastErr, lastSyncAt: Date.now() });
  return { ok: false, reason: lastErr || 'proxy unreachable — run `npm run proxy`' };
}

async function noteAttempt(a) {
  try {
    await chrome.storage.local.set({ lastAttempt: { at: Date.now(), ...a } });
  } catch { /* ignore */ }
}

async function tabHost(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return new URL(t.url).hostname;
  } catch {
    return `tab#${tabId}`;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'BLIBS_SCRAPE' && Array.isArray(msg.items)) {
    postImport(msg.items).then(async (r) => {
      // Don't let silent auto-pushes on page load overwrite the visible
      // diagnosis from a manual Sync — only record manual pushes or hits.
      if (msg.reason === 'manual' || msg.items.length) {
        await noteAttempt({
          tab: sender?.tab ? new URL(sender.tab.url).hostname : '?',
          selector: msg.debug?.used || '?',
          collected: msg.items.length,
          added: r.added ?? 0,
          error: r.ok ? undefined : r.reason,
        });
      }
      sendResponse({ ok: true, result: r, from: sender?.tab?.url });
      checkOutbox('scrape'); // piggyback: deliver anything blibs queued
    });
    return true; // async
  }
  if (msg?.type === 'BLIBS_SYNC_TAB' && msg.tabId != null) {
    (async () => {
      const host = await tabHost(msg.tabId);
      try {
        const r = await chrome.tabs.sendMessage(msg.tabId, { type: 'BLIBS_COLLECT_NOW' });
        const collected = r?.items?.length || 0;
        if (collected) {
          const posted = await postImport(r.items);
          await noteAttempt({
            tab: host, selector: r?.debug?.used || '?', collected,
            added: posted.added ?? 0, error: posted.ok ? undefined : posted.reason,
          });
          sendResponse({ ok: true, collected, selector: r?.debug?.used, posted });
        } else {
          const err = 'no messages matched our selectors — open a conversation; counts per selector in debug.counts';
          await noteAttempt({ tab: host, selector: r?.debug?.used || '(none)', collected: 0, error: err });
          sendResponse({ ok: true, collected: 0, debug: r?.debug, posted: { ok: false, reason: err } });
        }
      } catch (e) {
        const err = `tab not readable — content script missing. Reload the vendor tab (extension must be installed BEFORE the page loads): ${e?.message || e}`;
        await noteAttempt({ tab: host, collected: 0, error: err });
        sendResponse({ ok: false, reason: err });
      }
      checkOutbox('sync-tab');
    })();
    return true;
  }
  if (msg?.type === 'BLIBS_CHECK_OUTBOX') {
    checkOutbox('popup').then(() => sendResponse({ ok: true }));
    return true; // async
  }
  return false;
});

// 30s timer while the worker is alive (alarms cover sleep/wake).
setInterval(() => checkOutbox('timer'), 30000);

const TABS_BY_PROVIDER = {
  muse: ['https://muse.ai/*'],
  dots: ['https://chatgpt.com/*'],
  grok: ['https://grok.com/*'],
};

async function proxyBases() {
  return (await importUrls()).map((u) => u.replace(/\/api\/import$/, ''));
}

// ---- outbox delivery: blibs -> vendor tabs ----
// Anything blibs enqueues (POST /api/outbox) gets typed into the matching
// open tab and sent. Drained on every wake-up (see triggers at the bottom).
async function checkOutbox(reason) {
  for (const base of await proxyBases()) {
    let pending = [];
    try {
      const res = await fetch(`${base}/api/outbox/pending`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) continue;
      pending = data.items || [];
    } catch {
      continue; // this proxy base unreachable — try next
    }
    for (const item of pending.slice(0, 5)) {
      const patterns = TABS_BY_PROVIDER[String(item.provider || '').toLowerCase()];
      if (!patterns) {
        await ackOutbox(base, item.id, false, `no tab mapping for provider "${item.provider}"`);
        continue;
      }
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ url: patterns });
      } catch {
        continue;
      }
      if (!tabs.length) {
        await ackOutbox(base, item.id, false, `no open ${item.provider} tab — open + log in, then retry from blibs`);
        continue;
      }
      try {
        const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'BLIBS_SEND', id: item.id, text: item.text });
        await ackOutbox(base, item.id, !!r?.ok, r?.ok ? undefined : r?.reason || 'tab send failed');
        await noteAttempt({
          tab: new URL(tabs[0].url).hostname,
          selector: 'outbox-send',
          collected: 0,
          added: 0,
          error: r?.ok ? undefined : `send failed (${reason}): ${r?.reason || '?'}`,
        });
      } catch (e) {
        await ackOutbox(base, item.id, false, `tab not writable — reload the vendor tab: ${e?.message || e}`);
      }
    }
    if (pending.length) break; // first reachable proxy wins
  }
}

async function ackOutbox(base, id, ok, error) {
  try {
    await fetch(`${base}/api/outbox/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok, error }),
    });
  } catch { /* ack lost — item stays queued, retried next sweep */ }
}

// ---- automatic sync: periodic sweep over open vendor tabs ----
// The content-script MutationObserver handles real-time pushes; this sweep
// is the backup (catches tabs opened before install, missed mutations).
// Interval is configurable from the popup (autoSyncMinutes, 0 = off).
// Every sweep also drains the outbox (blibs -> tabs direction).
async function sweep(reason) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://muse.ai/*', 'https://chatgpt.com/*', 'https://grok.com/*'] });
  } catch {
    return;
  }
  let added = 0;
  for (const t of tabs.slice(0, 6)) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'BLIBS_COLLECT_NOW' });
      if (r?.items?.length) {
        const posted = await postImport(r.items);
        added += posted.added ?? 0;
      }
    } catch { /* tab not ready — next sweep */ }
  }
  try {
    await chrome.storage.local.set({ lastAutoAt: Date.now(), lastAutoAdded: added, lastAutoReason: reason });
  } catch { /* ignore */ }
  await checkOutbox(reason);
}

async function resetAlarm() {
  try {
    await chrome.alarms.clear('blibs-heartbeat');
    const { autoSyncMinutes } = await chrome.storage.local.get(['autoSyncMinutes']);
    const mins = autoSyncMinutes == null ? 1 : Number(autoSyncMinutes);
    if (mins > 0) {
      chrome.alarms.create('blibs-heartbeat', {
        periodInMinutes: Math.max(1, Math.min(mins, 60 * 24)),
      });
    }
  } catch { /* ignore */ }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoSyncMinutes' in changes) resetAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'blibs-heartbeat') sweep('alarm');
});
resetAlarm();
