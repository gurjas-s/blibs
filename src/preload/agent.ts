// blibs desktop preload — runs in every vendor view (muse.ai, chatgpt.com,
// grok.com) with full DOM access. Scrapes chats and delivers outbox sends,
// talking to the Electron main process over IPC.
//
// Outbound: ipcRenderer.send('blibs:scrape', {...collect(), reason})
// Inbound:  'blibs:collect-now' -> replies 'blibs:collect-result'
//           'blibs:send' {reqId, text} -> replies 'blibs:send-result'
import { ipcRenderer } from 'electron';

const PROVIDER_BY_HOST: Array<[RegExp, string]> = [
  [/(^|\.)muse\.ai$/, 'muse'],
  [/(^|\.)chatgpt\.com$/, 'dots'],
  [/(^|\.)grok\.com$/, 'grok'],
];

function detectProvider(): string {
  const host = location.hostname;
  for (const [re, id] of PROVIDER_BY_HOST) {
    if (re.test(host)) return id;
  }
  return 'custom';
}

const SELECTORS: string[] = [
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

type Role = 'user' | 'agent';

function roleOf(el: Element): Role {
  const attr = (el.getAttribute('data-message-author-role') || '').toLowerCase();
  if (attr.includes('user') || attr.includes('human')) return 'user';
  if (attr.includes('assistant') || attr.includes('agent') || attr.includes('bot')) return 'agent';
  const label = (el.getAttribute('aria-label') || el.getAttribute('data-testid') || '').toLowerCase();
  if (label.includes('user') || label.includes('you')) return 'user';
  // Alignment heuristic: own bubbles sit right, the agent's sit left.
  // Only trusted for bubble-width elements — full-width rows keep default.
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

interface ScrapeItem {
  provider: string;
  role: Role;
  text: string;
  ts: number;
  url: string;
}

interface CollectPayload {
  provider: string;
  items: ScrapeItem[];
  url: string;
  collectedAt: number;
  debug: { used: string; counts: Record<string, number> };
}

function collect(): CollectPayload {
  const provider = detectProvider();
  const counts: Record<string, number> = {};
  let nodes: Element[] = [];
  let used = '(none matched)';
  for (const sel of SELECTORS) {
    let n: Element[] = [];
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
  const items: ScrapeItem[] = [];
  const seen = new Set<string>();
  for (const el of nodes.slice(-100)) {
    const text = ((el as HTMLElement).innerText || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 4000);
    if (text.length < 2) continue;
    const key = text.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ provider, role: roleOf(el), text, ts: Date.now(), url: location.href });
  }
  return { provider, items, url: location.href, collectedAt: Date.now(), debug: { used, counts } };
}

let pushedOnce = false;

function push(reason: string): void {
  try {
    const session = reportSession();
    if (session.state !== 'ready') return;
    const payload = collect();
    if (!payload.items.length && pushedOnce) return;
    pushedOnce = true;
    ipcRenderer.send('blibs:scrape', { ...payload, reason });
  } catch {
    /* shutting down — ignore */
  }
}

function visible(el: Element): boolean {
  try {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
  } catch {
    return false;
  }
}

export type SessionState = 'loading' | 'ready' | 'signed-out' | 'error';
export interface SessionReport {
  state: SessionState;
  reason: string;
}
export interface VendorSession extends SessionReport {
  provider: string;
  updatedAt: number;
  lastSyncAt: number | null;
}

/** Use explicit login signals; an empty conversation alone is not a login wall. */
export function detectSession(): SessionReport {
  const loginPath = /\/(login|log-in|signin|sign-in)(\/|$)|\/auth\/(login|signin|sign-in)/i;
  if (loginPath.test(location.pathname) || /(^|\.)auth\.openai\.com$/.test(location.hostname)) {
    return { state: 'signed-out', reason: 'Sign in to sync your chats.' };
  }
  if (detectProvider() === 'custom') {
    return { state: 'error', reason: 'Open the agent conversation to resume syncing.' };
  }
  const hasVisible = (selector: string) => [...document.querySelectorAll(selector)].some(visible);
  // Signed-in controls take precedence over navigation links to login pages.
  if (hasVisible('[data-testid="profile-button"], [data-testid="user-menu"], button[aria-label*="account" i], a[href*="logout"]')) {
    return { state: 'ready', reason: 'Signed in. Chats sync automatically.' };
  }
  const loginButton = [...document.querySelectorAll('button, a')].some((element) =>
    visible(element) && /^(log in|sign in)\b/i.test((element.textContent || '').trim()),
  );
  if (loginButton || hasVisible('button[data-testid="login-button"], a[href*="/auth/login"], a[href="/login"], form input[type="password"]')) {
    return { state: 'signed-out', reason: 'Sign in to sync your chats.' };
  }
  if (hasVisible('div[contenteditable="true"], textarea, [role="textbox"]')) {
    return { state: 'ready', reason: 'Signed in. Chats sync automatically.' };
  }
  return { state: 'loading', reason: 'Waiting for the conversation to load.' };
}

function reportSession(): SessionReport {
  const session = detectSession();
  ipcRenderer.send('blibs:session', session);
  return session;
}

interface SendDebug {
  editors: number;
  sendButtons: number;
  sendButtonSel?: string;
}

interface SendOutcome {
  ok: boolean;
  reason?: string;
  method?: string;
  debug: SendDebug;
}

function trySend(text: string): SendOutcome {
  const debug: SendDebug = { editors: 0, sendButtons: 0 };
  if (!text.trim()) return { ok: false, reason: 'empty text', debug };
  if (detectSession().state === 'signed-out') {
    return { ok: false, reason: 'Sign in before sending this message.', debug };
  }
  const editors = [
    ...document.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'),
  ].filter(visible);
  debug.editors = editors.length;
  const ed = editors[editors.length - 1] as HTMLElement | undefined;
  if (!ed) return { ok: false, reason: 'composer not found (log in and open a conversation)', debug };
  ed.focus();
  try {
    if (ed.isContentEditable) {
      document.execCommand('insertText', false, text);
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      const input = ed as HTMLInputElement | HTMLTextAreaElement;
      const proto =
        input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (e) {
    return { ok: false, reason: `fill failed: ${(e as Error)?.message || e}`, debug };
  }
  const btnSels = ['button[aria-label*="send" i]', 'button[data-testid*="send"]', 'button[type="submit"]'];
  let btn: Element | null = null;
  let btnSel = '';
  for (const sel of btnSels) {
    try {
      btn = [...document.querySelectorAll(sel)].find((b) => {
        const hb = b as HTMLButtonElement;
        return visible(b) && !hb.disabled;
      }) || null;
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
    (btn as HTMLButtonElement).click();
    return { ok: true, method: `button:${btnSel}`, debug };
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    ed.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
  }
  return { ok: true, method: 'enter-key', debug };
}

setTimeout(() => push('load'), 4000);
setTimeout(() => push('load-late'), 12000);

ipcRenderer.on('blibs:collect-now', (_e, msg: { reqId?: string }) => {
  const session = reportSession();
  const payload = session.state === 'ready' ? collect() : { items: [] };
  ipcRenderer.send('blibs:collect-result', { reqId: msg?.reqId, ok: true, ...payload });
  push('manual');
});

ipcRenderer.on('blibs:send', (_e, msg: { reqId?: string; text?: unknown }) => {
  let r: SendOutcome;
  try {
    r = trySend(String(msg?.text || ''));
  } catch (e) {
    r = { ok: false, reason: `send crashed: ${(e as Error)?.message || e}`, debug: { editors: 0, sendButtons: 0 } };
  }
  ipcRenderer.send('blibs:send-result', { reqId: msg?.reqId, ...r });
});

// Real-time path: push ~8s after chat content changes (proxy dedupes).
let mutTimer: ReturnType<typeof setTimeout> | null = null;
let lastSig = '';
function sigNow(): string {
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
  /* observer unavailable — sweep covers us */
}
setInterval(() => push('interval'), 60000);
setInterval(() => reportSession(), 15000);
