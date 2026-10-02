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
  // Alignment heuristic for custom DOMs (e.g. muse.ai): the speaker's own
  // bubbles sit on the right, the agent's on the left. Only trusted for
  // bubble-width elements — full-width rows keep the default below.
  try {
    const r = el.getBoundingClientRect();
    const host = (el.closest && el.closest('main')) || document.body;
    const hr = host.getBoundingClientRect();
    if (hr.width > 0 && r.width < hr.width * 0.8) {
      const center = hr.left + hr.width / 2;
      if (r.left >= center - 8) return 'user';
      if (r.right <= center + 8) return 'agent';
    }
  } catch {
    /* fall through */
  }
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
  if (msg?.type === 'BLIBS_SEND') {
    // Blibs -> this tab: type the queued message into the composer and send.
    try {
      const r = trySend(String(msg.text || ''));
      respond({ ok: r.ok, method: r.method, reason: r.reason, debug: r.debug });
    } catch (e) {
      respond({ ok: false, reason: `send crashed: ${e?.message || e}` });
    }
  }
  return false;
});

function visible(el) {
  try {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
  } catch {
    return false;
  }
}

// Best-effort composer fill across vendor chat UIs (React-heavy).
// Returns { ok, method } — method tells you HOW it sent (button vs Enter).
function trySend(text) {
  const debug = { editors: 0, sendButtons: 0 };
  if (!text.trim()) return { ok: false, reason: 'empty text', debug };
  const editors = [
    ...document.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'),
  ].filter(visible);
  debug.editors = editors.length;
  const ed = editors[editors.length - 1];
  if (!ed) return { ok: false, reason: 'composer not found (open a conversation, not the homepage)', debug };
  ed.focus();
  try {
    if (ed.isContentEditable) {
      document.execCommand('insertText', false, text);
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        ed.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      )?.set;
      if (setter) setter.call(ed, text);
      else ed.value = text;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      ed.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (e) {
    return { ok: false, reason: `fill failed: ${e?.message || e}`, debug };
  }
  const btnSels = [
    'button[aria-label*="send" i]',
    'button[data-testid*="send"]',
    'button[type="submit"]',
  ];
  let btn = null;
  let btnSel = '';
  for (const sel of btnSels) {
    try {
      btn = [...document.querySelectorAll(sel)].find((b) => visible(b) && !b.disabled);
    } catch {
      btn = null;
    }
    if (btn) {
      btnSel = sel;
      break;
    }
  }
  debug.sendButtons = btn ? 1 : 0;
  debug.sendButtonSel = btnSel;
  if (btn) {
    btn.click();
    return { ok: true, method: `button:${btnSel}`, debug };
  }
  // Fallback: Enter key on the composer.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    ed.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
  }
  return { ok: true, method: 'enter-key', debug };
}

// ---- automatic sync: push whenever the chat DOM changes (debounced) ----
// This is the real-time path — no clicks needed. The proxy dedupes, so
// re-pushes are cheap. Backup sweeps (60s heartbeat + background alarm)
// cover anything the observer misses.
let mutTimer = null;
let lastSig = '';
function sigNow() {
  try {
    const t = document.body ? document.body.innerText || '' : '';
    return `${t.length}:${t.slice(-300)}`;
  } catch {
    return '';
  }
}
try {
  const obs = new MutationObserver(() => {
    if (mutTimer) return;
    mutTimer = setTimeout(() => {
      mutTimer = null;
      const sig = sigNow();
      if (sig && sig !== lastSig) {
        lastSig = sig;
        push('mutation');
      }
    }, 8000);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
} catch {
  /* observer unavailable — heartbeat below still covers us */
}
setInterval(() => push('interval'), 60000);
