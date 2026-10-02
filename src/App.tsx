import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { PROVIDERS, SEED_AGENTS, SEED_MESSAGES, mockReply, providerFor } from './providers';
import type { Agent, ChatMessage } from './types';

const LS_MSGS = 'blibs-messages-v1';
const LS_KEYS = 'blibs-keys-v1';
const LS_AGENTS = 'blibs-agents-v1';

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

function seedMessages(): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {};
  for (const [agentId, msgs] of Object.entries(SEED_MESSAGES)) {
    out[agentId] = msgs.map((m, i) => ({
      id: `${agentId}-seed-${i}`,
      agentId,
      role: m.role,
      text: m.text,
      ts: Date.now() - (msgs.length - i) * 60_000,
      source: 'mock' as const,
    }));
  }
  return out;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>(() => load(LS_AGENTS, SEED_AGENTS));
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>(() => {
    const cached = load<Record<string, ChatMessage[]> | null>(LS_MSGS, null);
    return cached ?? seedMessages();
  });
  const [keys, setKeys] = useState<Record<string, string>>(() => load(LS_KEYS, {}));
  const [activeId, setActiveId] = useState(agents[0]?.id ?? 'muse-1');
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [view, setView] = useState<'chat' | 'embed' | 'api'>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [extStatus, setExtStatus] = useState('extension idle — load it unpacked, open vendor tabs, then pull');
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  const activeMsgs = messages[active.id] ?? [];
  const meta = providerFor(active);

  useEffect(() => {
    localStorage.setItem(LS_MSGS, JSON.stringify(messages));
  }, [messages]);
  useEffect(() => {
    localStorage.setItem(LS_KEYS, JSON.stringify(keys));
  }, [keys]);
  useEffect(() => {
    localStorage.setItem(LS_AGENTS, JSON.stringify(agents));
  }, [agents]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMsgs.length, activeId, view]);

  const inbox = useMemo(() => {
    const all = Object.values(messages).flat().sort((a, b) => b.ts - a.ts);
    if (!query.trim()) return all.slice(0, 30);
    const q = query.toLowerCase();
    return all.filter((m) => m.text.toLowerCase().includes(q)).slice(0, 30);
  }, [messages, query]);

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    const userMsg: ChatMessage = { id: uid(), agentId: active.id, role: 'user', text, ts: Date.now(), source: 'mock' };
    setMessages((m) => ({ ...m, [active.id]: [...(m[active.id] ?? []), userMsg] }));
    setInput('');

    // Try live API via local proxy server (server/proxy.mjs). Falls back to mock.
    const key = keys[meta.keyName];
    let replyText: string | null = null;
    let source: ChatMessage['source'] = 'mock';
    if (key) {
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: meta.id, apiKey: key, message: text }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.reply) {
            replyText = data.reply;
            source = 'api';
          }
        }
      } catch {
        /* proxy not running — mock fallback */
      }
    }
    if (!replyText) {
      await new Promise((r) => setTimeout(r, 700));
      replyText = mockReply(meta.id, text);
    }
    const agentMsg: ChatMessage = { id: uid(), agentId: active.id, role: 'agent', text: replyText, ts: Date.now(), source };
    setMessages((m) => ({ ...m, [active.id]: [...(m[active.id] ?? []), agentMsg] }));
    setAgents((list) => list.map((a) => (a.id === active.id ? { ...a, lastActive: 'just now', status: source === 'api' ? 'online' : a.status } : a)));
    setSending(false);
  }

  function addAgent() {
    const n = agents.length + 1;
    const a: Agent = {
      id: `custom-${uid()}`,
      name: `Agent ${n}`,
      provider: 'custom',
      vendor: 'Custom',
      description: 'BYOK adapter — point at any OpenAI-compatible endpoint',
      color: '#a78bfa',
      avatar: '✨',
      status: 'needs-key',
      lastActive: 'just now',
    };
    setAgents((l) => [...l, a]);
    setActiveId(a.id);
    setView('chat');
  }

  // Companion-extension sync: GET /api/imports (via vite proxy -> :8787),
  // merge into threads by provider. Requires `npm run proxy` + unpacked extension.
  async function pullExtension() {
    setExtStatus('pulling from extension store…');
    try {
      const res = await fetch('/api/imports');
      if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
      const data = await res.json();
      const items: { provider: string; role: string; text: string; ts: number }[] = data?.imports ?? [];
      if (!items.length) {
        setExtStatus('store empty — open a vendor tab (logged in) and hit Sync in the extension popup, then pull again');
        return;
      }
      const next: typeof messages = { ...messages };
      let merged = 0;
      for (const it of items) {
        const prov = String(it.provider || 'custom');
        const target = agents.find((a) => a.provider === prov)?.id ?? active.id;
        const list = next[target] ?? [];
        if (list.some((m) => m.text === it.text && m.source === 'extension')) continue;
        next[target] = [
          ...list,
          {
            id: uid(),
            agentId: target,
            role: it.role === 'agent' ? 'agent' : 'user',
            text: it.text,
            ts: Number(it.ts) || Date.now(),
            source: 'extension' as const,
          },
        ];
        merged++;
      }
      setMessages(next);
      setAgents((list) => list.map((a) => ({ ...a, lastActive: 'just now' })));
      setExtStatus(`pulled ${items.length} stored from extension (${merged} new) — look for “extension” badges in the inbox`);
    } catch (e) {
      setExtStatus(`proxy unreachable (${String(e)}) — run \`npm run proxy\` on :8787, then pull again`);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◍</span>
          <div>
            <strong>blibs</strong>
            <span className="sub">personal-agent control panel · POC</span>
          </div>
        </div>
        <div className="search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all chats across Muse · Dots · Grok…" />
        </div>
        <div className="top-actions">
          <button className="ghost" onClick={() => setSettingsOpen((v) => !v)}>API keys</button>
          <button className="primary" onClick={addAgent}>+ agent</button>
        </div>
      </header>

      {settingsOpen && (
        <div className="keybar">
          {PROVIDERS.map((p) => (
            <label key={p.id} className="keyfield">
              <span>{p.vendor} · {p.keyName}</span>
              <input
                type="password"
                placeholder={keys[p.keyName] ? '•••••• saved (local only)' : `paste ${p.keyName}`}
                value={keys[p.keyName] ?? ''}
                onChange={(e) => setKeys((k) => ({ ...k, [p.keyName]: e.target.value.trim() }))}
              />
            </label>
          ))}
          <p className="hint">Keys stay in your browser localStorage and are only sent to your local proxy (<code>/api/chat</code>). Never commit them.</p>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <p className="section-label">Agents · {agents.length}</p>
          {agents.map((a) => (
            <button key={a.id} className={`agent ${a.id === activeId ? 'active' : ''}`} onClick={() => { setActiveId(a.id); setView('chat'); }}>
              <span className="avatar" style={{ background: a.color + '22', borderColor: a.color }}>{a.avatar}</span>
              <span className="ameta">
                <span className="aname">{a.name} <em>{a.vendor}</em></span>
                <span className="adesc">{a.description}</span>
                <span className="astatus"><i className={`dot ${a.status}`} />{a.status} · {a.lastActive}</span>
              </span>
            </button>
          ))}
          <div className="api-note">
            <strong>API reality check (Oct 2026)</strong>
            <ul>
              <li>No public <b>chat-history</b> API for Muse / Dots / Grok Bot consumer apps.</li>
              <li>Live model APIs exist: Meta Model API, OpenAI API, xAI API.</li>
              <li>So: <b>chat here via BYOK</b>, or open the real vendor app in a new tab (iframes are blocked).</li>
            </ul>
          </div>
        </aside>

        <main className="main">
          <div className="agent-head">
            <span className="avatar lg" style={{ background: active.color + '22', borderColor: active.color }}>{active.avatar}</span>
            <div>
              <h1>{active.name} <span className="vendor">· {meta.product}</span></h1>
              <p>{active.description}</p>
            </div>
            <div className="tabs">
              {(['chat', 'embed', 'api'] as const).map((t) => (
                <button key={t} className={view === t ? 'on' : ''} onClick={() => setView(t)}>
                  {t === 'chat' ? 'Unified chat' : t === 'embed' ? 'Embedded app' : 'API / adapter'}
                </button>
              ))}
            </div>
          </div>

          {view === 'chat' && (
            <>
              <div className="thread">
                {activeMsgs.map((m) => (
                  <div key={m.id} className={`msg ${m.role}`}>
                    <span className="badge">{m.role === 'user' ? 'you' : active.name} · {m.source}</span>
                    <p>{m.text}</p>
                  </div>
                ))}
                {sending && <div className="msg agent typing"><span className="badge">{active.name}</span><p>thinking…</p></div>}
                <div ref={bottomRef} />
              </div>
              <div className="composer">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                  placeholder={`Message ${active.name}… (Enter to send)`}
                />
                <button className="primary" onClick={send} disabled={sending}>Send</button>
              </div>
            </>
          )}

          {view === 'embed' && (
            <div className="embed">
              <p className="hint">
                ⚠️ Verified Oct 2026: all three vendors forbid framing —{' '}
                <code>muse.ai: X-Frame-Options SAMEORIGIN</code>,{' '}
                <code>chatgpt.com: SAMEORIGIN</code>,{' '}
                <code>grok.com: DENY</code>. The iframe below will render blank;
                use <a href={meta.embedUrl} target="_blank" rel="noreferrer">open {meta.product} in a new tab ↗</a> instead.
              </p>
              <iframe title={`${meta.product} embed (expected to be blocked by vendor)`} src={meta.embedUrl} sandbox="allow-scripts allow-same-origin allow-popups allow-forms" />
            </div>
          )}

          {view === 'api' && (
            <div className="api-panel">
              <div className="kv"><span>Endpoint</span><code>{meta.apiBase}</code></div>
              <div className="kv"><span>Model</span><code>{meta.model}</code></div>
              <div className="kv"><span>Key env</span><code>{meta.keyName}</code></div>
              <div className="kv"><span>Docs</span><a href={meta.docs} target="_blank" rel="noreferrer">{meta.docs}</a></div>
              <div className="kv"><span>History API?</span><b>{meta.hasChatHistoryApi ? 'yes' : 'no — framing blocked, deep-link out'}</b></div>
              <p className="hint">{meta.notes}</p>
              <pre className="code">{`# local proxy (server/proxy.mjs)
${meta.keyName}=sk-... npm run proxy   # :8787
# frontend POSTs { provider, apiKey, message } to /api/chat
# proxy fans out to Meta / OpenAI / xAI chat endpoints`}</pre>
            </div>
          )}
        </main>

        <aside className="inbox">
          <p className="section-label">{query ? `Results for “${query}”` : 'All chats · unified inbox'}</p>
          <div className="ext-box">
            <button className="ghost" onClick={pullExtension}>Pull from extension</button>
            <p className="hint">{extStatus}</p>
          </div>
          {inbox.map((m) => (
            <button key={m.id} className="inbox-item" onClick={() => { setActiveId(m.agentId); setView('chat'); }}>
              <strong>{agentName(m.agentId)}</strong>
              <span className={`role ${m.role}`}>{m.role}</span>
              <p>{m.text}</p>
            </button>
          ))}
          {inbox.length === 0 && <p className="hint">No messages yet — send one from Unified chat.</p>}
        </aside>
      </div>

      <footer className="foot">
        <span>POC: unified inbox + per-agent chat + embedded vendor apps + BYOK API adapters. History is localStorage; wire a DB + OAuth when vendors open history APIs.</span>
      </footer>
    </div>
  );
}
