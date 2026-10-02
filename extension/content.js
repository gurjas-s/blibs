// blibs companion — content script.
// Runs IN the vendor page as you (logged in), scrapes the chats YOU can
// already see, and hands them to background.js for POSTing to localhost.
// No credentials are read. If a vendor redesigns their DOM, update SELECTORS.

const PROVIDER_BY_HOST = [
  [/muse\.ai$/, 'muse'],
  [/chatgpt\.com$/, 'dots'],
  [/grok\.com$/, 'grok'],
];

function detectProvider() {
  const host = location.hostname;
  for (const [re, id] of PROVIDER_BY_HOST) {
    if (re.test(host)) return id;
  }
  return 'custom';
}

// Ordered candidates: newest vendor DOM first, generic fallback last.
// data-message-author-role is used by ChatGPT/Grok-family UIs ("user"|"assistant").
// Muse and others use custom markup — hence the generic tail + debug counts.
const SELECTORS = [
  '[data-message-author-role]',
  '[data-testid*="conversation-turn"]',
  '[data-testid*="message"]',
  'main [role="listitem"]',
  '[role="log"] > *',
  'main article',
  'article',
  '[class*="chat-message"]',
  '[class*="message-bubble"]',
  '[class*="bubble"]',
];

function roleOf(el) {
  const attr = (el.getAttribute('data-message-author-role') || '').toLowerCase();
  if (attr.includes('user') || attr.includes('human')) return 'user';
  if (attr.includes('assistant') || attr.includes('agent') || attr.includes('bot')) return 'agent';
  const label = (el.getAttribute('aria-label') || el.getAttribute('data-testid') || '').toLowerCase();
  if (label.includes('user') || label.includes('you')) return 'user';
  return 'agent';
}

function collect() {
  const provider = detectProvider();
  const counts = {};
  let nodes = [];
  let used = '(none matched)';
  for (const sel of SELECTORS) {
    let n = [];
    try {
      n = [...document.querySelectorAll(sel)];
    } catch {
      n = [];
    }
    counts[sel] = n.length;
    if (n.length && !nodes.length) {
      nodes = n;
      used = sel;
    }
  }
  const items = [];
  const seen = new Set();
  for (const el of nodes.slice(-100)) {
    const text = (el.innerText || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 4000);
    if (text.length < 2) continue;
    const key = text.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ provider, role: roleOf(el), text, ts: Date.now(), url: location.href });
  }
  return { provider, items, url: location.href, collectedAt: Date.now(), debug: { used, counts } };
}

// Push on load (debounced — vendor apps hydrate async) + when asked.
let pushed = false;
function push(reason) {
  try {
    const payload = collect();
    if (!payload.items.length && pushed) return;
    pushed = true;
    chrome.runtime.sendMessage({ type: 'BLIBS_SCRAPE', reason, ...payload });
  } catch {
    /* extension context revoked — ignore */
  }
}

setTimeout(() => push('load'), 4000);
setTimeout(() => push('load-late'), 12000);

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'BLIBS_COLLECT_NOW') {
    const payload = collect();
    respond({ ok: true, ...payload });
    push('manual');
  }
  return false;
});
