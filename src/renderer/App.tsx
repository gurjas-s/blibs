import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { SEED_AGENTS, providerFor } from './providers';
import type { Agent, ChatMessage, VendorSession } from './types';
import { cleanImportText } from './text';
import SessionStatus from './SessionStatus';

const LS_MSGS = 'blibs-messages-v2';
const LS_AGENTS = 'blibs-agents-v2';
const LS_AUTOPULL = 'blibs-autopull-v1';
const LS_PULLSECS = 'blibs-pullsecs-v1';

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'not synced yet';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>(() => load(LS_AGENTS, SEED_AGENTS));
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>(() => load(LS_MSGS, {}));
  const [activeId, setActiveId] = useState(agents[0]?.id ?? 'muse');
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusLine, setStatusLine] = useState('Waiting for sync — log in via the Agents menu.');
  const [lastPull, setLastPull] = useState<{ at: number; ok: boolean } | null>(null);
  const [autoPull, setAutoPull] = useState<boolean>(() => load(LS_AUTOPULL, true));
  const [pullSecs, setPullSecs] = useState<number>(() => load(LS_PULLSECS, 15));
  const [sessions, setSessions] = useState<VendorSession[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  const meta = providerFor(active);
  const activeSession = sessions.find((session) => session.provider === active.provider);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await window.blibs?.sessions();
        if (!disposed && next) setSessions(next);
      } catch { /* The next poll retries the desktop connection. */ }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  async function signIn(provider: string) {
    try {
      if (!window.blibs) throw new Error('Open the desktop app to sign in.');
      await window.blibs.signIn(provider);
      setStatusLine('Complete sign-in in the window that opened. Your chats will sync automatically.');
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : 'Could not open sign-in. Try again.');
    }
  }

  const messagesRef = useRef(messages);
  const agentsRef = useRef(agents);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);
  useEffect(() => {
    localStorage.setItem(LS_MSGS, JSON.stringify(messages));
  }, [messages]);
  useEffect(() => {
    localStorage.setItem(LS_AGENTS, JSON.stringify(agents));
  }, [agents]);
  useEffect(() => {
    localStorage.setItem(LS_AUTOPULL, JSON.stringify(autoPull));
  }, [autoPull]);
  useEffect(() => {
    localStorage.setItem(LS_PULLSECS, JSON.stringify(pullSecs));
  }, [pullSecs]);

  const thread = useMemo(() => {
    const list = [...(messages[active.id] ?? [])].sort((a, b) => a.ts - b.ts);
    const q = query.trim().toLowerCase();
    return q ? list.filter((m) => m.text.toLowerCase().includes(q)) : list;
  }, [messages, active.id, query]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: query ? 'auto' : 'smooth', block: 'end' });
  }, [thread.length, activeId, query]);

  /** Merge desktop imports, cleaning scrape artifacts and collapsing
   *  echoes of messages already sent from here (the "double message" bug). */
  async function pullImports(silent = false) {
    if (!silent) setStatusLine('Syncing…');
    try {
      const res = await fetch('/api/imports');
      if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
      const data = await res.json();
      const items: { provider: string; role: string; text: string; ts: number }[] = data?.imports ?? [];
      const cur = messagesRef.current;
      const ags = agentsRef.current;
      const next: typeof cur = { ...cur };
      let merged = 0;
      for (const it of items) {
        const text = cleanImportText(it.text || '');
        if (!text) continue;
        const prov = String(it.provider || 'custom');
        const target = ags.find((a) => a.provider === prov)?.id;
        if (!target) continue;
        const norm = text.toLowerCase();
        const dup = (next[target] ?? []).some((m) => cleanImportText(m.text).toLowerCase() === norm);
        if (dup) continue;
        next[target] = [
          ...(next[target] ?? []),
          {
            id: uid(),
            agentId: target,
            role: it.role === 'agent' ? 'agent' : 'user',
            text,
            ts: Number(it.ts) || Date.now(),
            source: 'desktop',
          },
        ];
        merged++;
      }
      if (merged) {
        setMessages(next);
        const now = Date.now();
        setAgents((list) =>
          list.map((a) => (next[a.id] && next[a.id].length !== (cur[a.id] ?? []).length ? { ...a, lastSyncAt: now } : a)),
        );
      }
      setLastPull({ at: Date.now(), ok: true });
      setStatusLine(
        merged
          ? `${merged} new message${merged === 1 ? '' : 's'} synced`
          : 'Up to date — new chats appear here automatically',
      );
    } catch {
      setLastPull({ at: Date.now(), ok: false });
      setStatusLine('Backend unreachable — restart the app.');
    }
  }

  async function syncOutboxStatuses() {
    try {
      const res = await fetch('/api/outbox');
      if (!res.ok) return;
      const data = await res.json();
      const byId = new Map<string, string>((data?.items ?? []).map((o: { id: string; status: string }) => [o.id, o.status]));
      if (!byId.size) return;
      const cur = messagesRef.current;
      let changed = false;
      const next: typeof cur = {};
      for (const [agentId, list] of Object.entries(cur)) {
        next[agentId] = list.map((m) => {
          if (!m.outId) return m;
          const st = byId.get(m.outId) as ChatMessage['outStatus'] | undefined;
          if (st && st !== m.outStatus) {
            changed = true;
            return { ...m, outStatus: st };
          }
          return m;
        });
      }
      if (changed) setMessages(next);
    } catch {
      /* proxy down — status line already says so */
    }
  }

  useEffect(() => {
    pullImports(true);
    if (!autoPull) return;
    const id = setInterval(() => {
      pullImports(true);
      syncOutboxStatuses();
    }, Math.max(5, pullSecs) * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPull, pullSecs]);

  /** Send into the real vendor session via the outbox. */
  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    const userMsg: ChatMessage = {
      id: uid(), agentId: active.id, role: 'user', text,
      ts: Date.now(), source: 'desktop', via: 'tab', outStatus: 'queued',
    };
    setMessages((m) => ({ ...m, [active.id]: [...(m[active.id] ?? []), userMsg] }));
    try {
      const res = await fetch('/api/outbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: meta.id, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.id) throw new Error(data?.error || `proxy HTTP ${res.status}`);
      const outId = data.id as string;
      setMessages((m) => ({
        ...m,
        [active.id]: (m[active.id] ?? []).map((x) => (x.id === userMsg.id ? { ...x, outId } : x)),
      }));
      setStatusLine(`Sent to your logged-in ${meta.product} session — its reply syncs back automatically.`);
    } catch (e) {
      setMessages((m) => ({
        ...m,
        [active.id]: (m[active.id] ?? []).map((x) =>
          x.id === userMsg.id ? { ...x, outStatus: 'failed' as const } : x,
        ),
      }));
      setStatusLine(`Could not queue (${String(e)}). Is the backend running? Your text is kept — retry below.`);
    }
    setSending(false);
  }

  async function retryOutbox(outId: string) {
    try {
      const res = await fetch('/api/outbox/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: outId }),
      });
      if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
      setMessages((m) => {
        const next = { ...m };
        for (const [agentId, list] of Object.entries(next)) {
          next[agentId] = list.map((x) => (x.outId === outId ? { ...x, outStatus: 'queued' as const } : x));
        }
        return next;
      });
      setStatusLine('Re-queued — the app picks it up within a minute.');
    } catch {
      setStatusLine('Retry failed — is the backend running?');
    }
  }

  const pill = !lastPull
    ? { cls: 'idle', label: 'Waiting for sync' }
    : lastPull.ok
      ? { cls: 'live', label: `Synced ${clock(lastPull.at)}` }
      : { cls: 'down', label: 'Backend unreachable' };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark">b</span>
          <strong>blibs</strong>
        </div>
        <div className="search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${active.name}…`}
            aria-label="Search current chat"
          />
        </div>
        <div className={`sync-pill ${pill.cls}`} title={statusLine}>
          <span className="dot" />
          {pill.label}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <p className="section-label">Agents</p>
          {agents.map((a) => (
            <div key={a.id} className={`agent ${a.id === activeId ? 'active' : ''}`}>
              <button className="agent-main" onClick={() => setActiveId(a.id)}>
                <span className="avatar">{a.name.charAt(0)}</span>
                <span className="ameta">
                  <span className="aname">{a.name}</span>
                  <span className="avendor">{a.vendor}</span>
                  <SessionStatus session={sessions.find((session) => session.provider === a.provider)} />
                  <span className="async">{a.lastSyncAt ? `Synced ${timeAgo(a.lastSyncAt)}` : 'Waiting for chats'}</span>
                </span>
              </button>
              <a className="open-tab" href={a.site} target="_blank" rel="noreferrer" title={`Open ${a.name} in a new tab`}>
                ↗
              </a>
              {sessions.find((session) => session.provider === a.provider)?.state === 'signed-out' && (
                <button className="sign-in" onClick={() => signIn(a.provider)} aria-label={`Sign in to ${a.name}`}>Sign in</button>
              )}
            </div>
          ))}
          <div className="side-foot">
            <label className="auto-row" title="Pull synced chats on a timer">
              <input type="checkbox" checked={autoPull} onChange={(e) => setAutoPull(e.target.checked)} />
              Auto-sync
              <select value={pullSecs} onChange={(e) => setPullSecs(Number(e.target.value))} aria-label="Auto-sync interval">
                <option value={15}>15s</option>
                <option value={30}>30s</option>
                <option value={60}>1m</option>
                <option value={300}>5m</option>
              </select>
            </label>
            <p>Sessions live inside this app — use the Agents menu to log in.</p>
          </div>
        </aside>

        <main className="main">
          <div className="thread-head">
            <div>
              <h1>{active.name}</h1>
              <p>{active.description}</p>
            </div>
            <a className="open-tab big" href={active.site} target="_blank" rel="noreferrer">
              Open {active.name} ↗
            </a>
          </div>

          <div className="thread">
            {activeSession?.state === 'signed-out' && (
              <div className="session-notice" role="status">
                <p>Sign in to {active.name} to sync your chats. Your saved messages are still here.</p>
                <button className="sign-in" onClick={() => signIn(active.provider)}>Sign in to {active.name}</button>
              </div>
            )}
            {thread.length === 0 && (
              <div className="empty">
                <p className="empty-title">{query ? 'No matches' : `No chats with ${active.name} yet`}</p>
                {!query && (
                  <ol>
                    <li>Log in via the Agents menu (once per agent)</li>
                    <li>Chats sync here on their own — replies you send go to the real session</li>
                  </ol>
                )}
              </div>
            )}
            {thread.map((m) => (
              <div key={m.id} className={`msg ${m.role}`} title={new Date(m.ts).toLocaleString()}>
                <p>{m.text}</p>
                {m.role === 'user' && m.via === 'tab' && m.outStatus && m.outStatus !== 'sent' && (
                  <span className={`receipt ${m.outStatus}`}>
                    {m.outStatus === 'queued' ? 'Sending…' : 'Not delivered'}
                    {m.outStatus === 'failed' && m.outId && (
                      <button onClick={() => retryOutbox(m.outId!)}>Retry</button>
                    )}
                  </span>
                )}
                {m.role === 'user' && m.via === 'tab' && m.outStatus === 'sent' && (
                  <span className="receipt sent">Sent</span>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="composer">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              placeholder={`Message ${active.name}…`}
              aria-label={`Message ${active.name}`}
            />
            <button className="primary" onClick={send} disabled={sending || !input.trim()}>
              Send
            </button>
          </div>
          <p className="status-line">{statusLine}</p>
        </main>
      </div>
    </div>
  );
}
