import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import { SEED_AGENTS, providerFor } from './providers';
import type { Agent, ChatMessage, VendorSession } from './types';
import { mergeImports } from './messages';
import type { ImportedMessage, Messages } from './messages';
import SessionStatus from './SessionStatus';
import ChatThread from './ChatThread';
import Onboarding from './Onboarding';
import { ONBOARDING_KEY, readOnboarding } from './onboarding-state';

const LS_MSGS = 'blibs-messages-v2';
const LS_AGENTS = 'blibs-agents-v2';
const LS_AUTOPULL = 'blibs-autopull-v1';
const LS_PULLSECS = 'blibs-pullsecs-v1';

function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep this session usable when storage is full. */ }
}
function timeAgo(timestamp: number | null): string {
  if (!timestamp) return 'Waiting for chats';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Synced just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} hr ago`;
  return `Synced ${Math.floor(hours / 24)} days ago`;
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not complete this request. Try again.');
  return data as T;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>(() => {
    const stored = load<Agent[]>(LS_AGENTS, SEED_AGENTS);
    return Array.isArray(stored) && stored.length ? stored : SEED_AGENTS;
  });
  const [messages, setMessages] = useState<Messages>(() => load(LS_MSGS, {}));
  const [activeId, setActiveId] = useState(agents[0].id);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState<string[]>([]);
  const [scrollRequest, setScrollRequest] = useState(0);
  const [statusLine, setStatusLine] = useState('Choose an agent to view your chats.');
  const [lastPull, setLastPull] = useState<{ at: number; ok: boolean } | null>(null);
  const [autoPull, setAutoPull] = useState(() => load(LS_AUTOPULL, true));
  const [pullSecs, setPullSecs] = useState(() => load(LS_PULLSECS, 15));
  const [sessions, setSessions] = useState<VendorSession[]>([]);
  const [onboarding, setOnboarding] = useState(() => readOnboarding(load(ONBOARDING_KEY, null)));
  const active = agents.find((agent) => agent.id === activeId) || agents[0];
  const meta = providerFor(active);
  const activeSession = sessions.find((session) => session.provider === active.provider);
  const input = drafts[active.id] || '';
  const providerKey = JSON.stringify(agents.map(({ id, provider }) => ({ id, provider })));
  const routes = useMemo(() => JSON.parse(providerKey) as Pick<Agent, 'id' | 'provider'>[], [providerKey]);

  useEffect(() => { save(LS_MSGS, messages); }, [messages]);
  useEffect(() => { save(LS_AGENTS, agents); }, [agents]);
  useEffect(() => { save(LS_AUTOPULL, autoPull); }, [autoPull]);
  useEffect(() => { save(LS_PULLSECS, pullSecs); }, [pullSecs]);
  useEffect(() => { save(ONBOARDING_KEY, onboarding); }, [onboarding]);
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const next = await window.blibs?.sessions();
        if (!disposed && next) setSessions(next);
      } catch {
        if (!disposed) setSessions(SEED_AGENTS.map((agent) => ({
          provider: agent.provider, state: 'error', reason: 'Could not check sign-in. Try opening the agent again.', updatedAt: Date.now(), lastSyncAt: null,
        })));
      }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  async function signIn(provider: string) {
    try {
      if (!window.blibs) throw new Error('Open the desktop app to sign in.');
      await window.blibs.signIn(provider);
      setStatusLine('Complete sign-in in the window that opened. Your chats will sync automatically.');
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open sign-in. Try again.';
      setStatusLine(message);
      return message;
    }
  }

  const pullImports = useCallback(async (silent = false) => {
    if (!silent) setStatusLine('Syncing your chats…');
    try {
      const data = await request<{ imports: ImportedMessage[] }>('/api/imports');
      setMessages((current) => mergeImports(current, routes, data.imports));
      const latest = new Map<string, number>();
      for (const message of data.imports) latest.set(message.provider, Math.max(latest.get(message.provider) || 0, message.ts));
      setAgents((current) => current.map((agent) => {
        const timestamp = latest.get(agent.provider);
        return timestamp && timestamp > (agent.lastSyncAt || 0) ? { ...agent, lastSyncAt: timestamp } : agent;
      }));
      setLastPull({ at: Date.now(), ok: true });
      if (!silent) setStatusLine('Your chats are up to date.');
    } catch {
      setLastPull({ at: Date.now(), ok: false });
      if (!silent) setStatusLine('Could not sync your chats. Select Sync now to try again.');
    }
  }, [routes]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- This starts a fetch; state updates occur after its response.
    void pullImports(true);
    const settingUp = onboarding.step === 'sync';
    if (!autoPull && !settingUp) return;
    const timer = setInterval(() => { void pullImports(true); }, (settingUp ? 5 : Math.max(5, pullSecs)) * 1000);
    return () => clearInterval(timer);
  }, [autoPull, pullSecs, pullImports, onboarding.step]);

  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const data = await request<{ items: { id: string; status: ChatMessage['outStatus']; error?: string }[] }>('/api/outbox');
        if (disposed) return;
        const byId = new Map(data.items.map((item) => [item.id, item]));
        setMessages((current) => {
          let changed = false;
          const next: Messages = {};
          for (const [id, list] of Object.entries(current)) next[id] = list.map((message) => {
            const item = message.outId && byId.get(message.outId);
            if (!item || (item.status === message.outStatus && item.error === message.outError)) return message;
            changed = true;
            return { ...message, outStatus: item.status, outError: item.error };
          });
          return changed ? next : current;
        });
      } catch { /* Retain delivery states and retry on the next tick. */ }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  const thread = useMemo(() => {
    const list = [...(messages[active.id] || [])].sort((a, b) => a.ts - b.ts);
    const term = query.trim().toLowerCase();
    return term ? list.filter((message) => message.text.toLowerCase().includes(term)) : list;
  }, [messages, active.id, query]);

  function updateMessage(message: ChatMessage, changes: Partial<ChatMessage>) {
    setMessages((current) => ({ ...current, [message.agentId]: (current[message.agentId] || []).map((item) => item.id === message.id ? { ...item, ...changes } : item) }));
  }
  async function queue(message: ChatMessage, provider: string) {
    try {
      const data = await request<{ id: string; status: ChatMessage['outStatus'] }>('/api/outbox', { provider, text: message.text, clientId: message.id });
      updateMessage(message, { outId: data.id, outStatus: data.status || 'queued', outError: undefined });
      setStatusLine('Message queued. It will send when the agent is connected.');
    } catch (error) {
      updateMessage(message, { outStatus: 'failed', outError: 'Could not queue this message. Select Retry to try again.' });
      setStatusLine(error instanceof Error ? error.message : 'Could not queue your message. Try again.');
    }
  }
  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const message: ChatMessage = { id: crypto.randomUUID(), agentId: active.id, role: 'user', text, ts: Date.now(), source: 'desktop', via: 'tab', outStatus: 'queued' };
    setSending(true);
    setDrafts((current) => ({ ...current, [active.id]: '' }));
    setMessages((current) => ({ ...current, [active.id]: [...(current[active.id] || []), message] }));
    setScrollRequest((value) => value + 1);
    await queue(message, meta.id);
    setSending(false);
  }
  async function retry(message: ChatMessage) {
    if (retrying.includes(message.id)) return;
    setRetrying((current) => [...current, message.id]);
    try {
      if (!message.outId) await queue(message, agents.find((agent) => agent.id === message.agentId)!.provider);
      else {
        await request('/api/outbox/retry', { id: message.outId });
        updateMessage(message, { outStatus: 'queued', outError: undefined });
        setStatusLine('Message queued again. It will send when the agent is connected.');
      }
    } catch {
      updateMessage(message, { outError: 'Could not retry this message. Check your connection and try again.' });
    } finally { setRetrying((current) => current.filter((id) => id !== message.id)); }
  }

  const pillLabel = lastPull?.ok ? 'Chats connected' : lastPull ? 'Sync unavailable' : 'Connecting';
  const empty = <div className="empty">
    <p className="empty-title">{query ? 'No matching messages' : activeSession?.state === 'signed-out' ? `Sign in to ${active.name}` : activeSession?.state === 'error' ? `Could not connect to ${active.name}` : activeSession?.state === 'ready' ? 'Waiting for your first chat' : `Connecting to ${active.name}`}</p>
    <p>{query ? 'Try a different search.' : activeSession?.state === 'ready' ? `Open a conversation in ${active.name}. Your messages will appear here automatically.` : activeSession?.reason || 'Checking your saved sign-in. This may take a moment.'}</p>
    {!query && <button className="sign-in" onClick={() => signIn(active.provider)}>{activeSession?.state === 'ready' ? `Open ${active.name}` : `Sign in to ${active.name}`}</button>}
  </div>;

  return <div className="shell">
    <header className="topbar">
      <div className="brand"><span className="mark" aria-hidden="true">b</span><strong>blibs</strong></div>
      <div className="search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${active.name}…`} aria-label="Search current chat" /></div>
      <div className={`sync-pill ${lastPull?.ok ? 'live' : lastPull ? 'down' : 'idle'}`} role="status"><span className="dot" aria-hidden="true" />{pillLabel}</div>
    </header>
    <div className="layout">
      <aside className="sidebar" aria-label="Agents">
        <p className="section-label">Agents</p>
        <div className="agent-list">{agents.map((agent) => {
          const session = sessions.find((item) => item.provider === agent.provider);
          return <div key={agent.id} className={`agent-card ${agent.id === active.id ? 'active' : ''}`}>
            <button className="agent-main" aria-pressed={agent.id === active.id} onClick={() => { setActiveId(agent.id); setQuery(''); }}>
              <span className="avatar" aria-hidden="true">{agent.name.charAt(0)}</span>
              <span className="ameta"><span className="aname">{agent.name}</span><span className="avendor">{agent.vendor}</span>
                <SessionStatus session={session} /><span className="async">{timeAgo(session?.lastSyncAt || agent.lastSyncAt)}</span>
              </span>
            </button>
            {session?.state === 'error' && <p className="agent-error">{session.reason}</p>}
            {session?.state !== 'ready' && <button className="sign-in" onClick={() => signIn(agent.provider)} aria-label={`Sign in to ${agent.name}`}>Sign in</button>}
          </div>;
        })}</div>
        <div className="side-foot">
          <button className="sign-in" onClick={() => setOnboarding({ step: 'welcome', providers: [] })}>Set up agents</button>
          <button className="sign-in" onClick={() => pullImports()}>Sync now</button>
          <label className="auto-row"><input type="checkbox" checked={autoPull} onChange={(event) => setAutoPull(event.target.checked)} />Sync automatically</label>
          <label className="interval-row">Check every <select value={pullSecs} onChange={(event) => setPullSecs(Number(event.target.value))} aria-label="Sync frequency">
            <option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={300}>5 minutes</option>
          </select></label>
        </div>
      </aside>
      <main className="main">
        <div className="thread-head"><div><h1>{active.name}</h1><SessionStatus session={activeSession} /></div><button className="sign-in" onClick={() => signIn(active.provider)}>{activeSession?.state === 'ready' ? `Open ${active.name}` : `Sign in to ${active.name}`}</button></div>
        {lastPull && !lastPull.ok && <div className="connection-notice" role="alert">Chats could not sync. Your saved messages are still available. <button onClick={() => pullImports()}>Try again</button></div>}
        <ChatThread key={active.id} messages={thread} agentName={active.name} query={query} empty={empty} onRetry={retry} retrying={retrying} scrollRequest={scrollRequest}
          notice={activeSession?.state === 'signed-out' && thread.length > 0 ? <div className="session-notice" role="status"><p>Sign in to {active.name} to sync new chats and send queued messages.</p><button className="sign-in" onClick={() => signIn(active.provider)}>Sign in to {active.name}</button></div> : undefined} />
        <div className="composer"><textarea value={input} rows={2} maxLength={4000} onChange={(event) => setDrafts((current) => ({ ...current, [active.id]: event.target.value }))} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }} placeholder={`Message ${active.name}…`} aria-label={`Message ${active.name}`} /><button className="primary" onClick={send} disabled={sending || !input.trim()}>{sending ? 'Queuing…' : 'Send'}</button></div>
        <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
        <p className="status-line" role="status">{statusLine}</p>
      </main>
    </div>
    {onboarding.step !== 'complete' && <Onboarding progress={onboarding} agents={agents} sessions={sessions} messages={messages} syncUnavailable={lastPull?.ok === false} onChange={setOnboarding} onSignIn={signIn} onSync={() => pullImports()} onSelect={setActiveId} />}
  </div>;
}
