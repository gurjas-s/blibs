import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { SEED_AGENTS, providerFor } from './providers';
import type { Agent, ChatMessage } from './types';
import { cleanImportText } from './text';
import SearchPanel from './SearchPanel';
import {
  fetchImports,
  fetchOutboxStatuses,
  queueOutbox,
  retryOutbox as retryOutboxItem,
} from './client';
import { AgentListItem } from './components/AgentListItem';
import { Button } from './components/Button';
import { CheckboxField } from './components/CheckboxField';
import { EmptyState } from './components/EmptyState';
import { LinkButton } from './components/LinkButton';
import { MessageBubble } from './components/MessageBubble';
import { SectionLabel } from './components/SectionLabel';
import { SelectField } from './components/SelectField';
import { StatusPill } from './components/StatusPill';
import type { StatusTone } from './components/StatusPill';
import { TextField } from './components/TextField';

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
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusLine, setStatusLine] = useState('Waiting for sync — log in via the Agents menu.');
  const [lastPull, setLastPull] = useState<{ at: number; ok: boolean } | null>(null);
  const [autoPull, setAutoPull] = useState<boolean>(() => load(LS_AUTOPULL, true));
  const [pullSecs, setPullSecs] = useState<number>(() => load(LS_PULLSECS, 15));
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  const meta = providerFor(active);

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
      const items = await fetchImports();
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
        const role = it.role === 'agent' ? 'agent' : 'user';
        const list = next[target] ?? [];
        const existing = list.find(m => m.historyId === it.id) ?? list.find(m => {
          if (m.historyId || m.role !== role || cleanImportText(m.text) !== text) return false;
          // Imports use first-observed times. Delivery may occur long after a send or retry.
          return m.ts === it.ts || (m.via === 'tab' && it.ts >= m.ts);
        });
        if (existing) {
          if (existing.historyId !== it.id || existing.text !== text || existing.role !== role) {
            next[target] = list.map(m => m.id === existing.id ? { ...m, historyId: it.id, text, role } : m);
            merged++;
          }
          continue;
        }
        next[target] = [
          ...(next[target] ?? []),
          {
            id: `history:${it.id}`,
            historyId: it.id,
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
      const byId = await fetchOutboxStatuses();
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
      const outId = await queueOutbox(meta.id, text);
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

  async function retryDelivery(outId: string) {
    try {
      await retryOutboxItem(outId);
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

  const pill: { tone: StatusTone; label: string } = !lastPull
    ? { tone: 'idle', label: 'Waiting for sync' }
    : lastPull.ok
      ? { tone: 'live', label: `Synced ${clock(lastPull.at)}` }
      : { tone: 'down', label: 'Backend unreachable' };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark">b</span>
          <strong>blibs</strong>
        </div>
        <div className="search">
          {showHistory ? <span>Local conversation history</span> : (
            <TextField
              hideLabel
              label="Search current chat"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${active.name}…`}
            />
          )}
        </div>
        <StatusPill tone={pill.tone} title={statusLine}>
          {pill.label}
        </StatusPill>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <SectionLabel>Agents</SectionLabel>
          {agents.map((a) => (
            <AgentListItem
              key={a.id}
              agent={a}
              active={a.id === activeId}
              syncLabel={a.lastSyncAt ? `synced ${timeAgo(a.lastSyncAt)}` : 'not synced yet'}
              onSelect={(id) => {
                setActiveId(id);
                setShowHistory(false);
              }}
            />
          ))}
          <div className="side-foot">
            <Button
              variant="secondary"
              size="lg"
              className={showHistory ? 'history-nav selected' : 'history-nav'}
              onClick={() => setShowHistory(true)}
            >
              Search all conversations
            </Button>
            <div className="auto-row" title="Pull synced chats on a timer">
              <CheckboxField
                label="Auto-sync"
                checked={autoPull}
                onChange={(e) => setAutoPull(e.target.checked)}
              />
              <SelectField
                hideLabel
                label="Auto-sync interval"
                value={pullSecs}
                onChange={(e) => setPullSecs(Number(e.target.value))}
              >
                <option value={15}>15s</option>
                <option value={30}>30s</option>
                <option value={60}>1m</option>
                <option value={300}>5m</option>
              </SelectField>
            </div>
            <p>Sessions live inside this app — use the Agents menu to log in.</p>
          </div>
        </aside>

        <main className="main">
          {showHistory ? <SearchPanel /> : <>
          <div className="thread-head">
            <div>
              <h1>{active.name}</h1>
              <p>{active.description}</p>
            </div>
            <LinkButton
              variant="secondary"
              href={active.site}
              target="_blank"
              rel="noreferrer"
            >
              Open {active.name} ↗
            </LinkButton>
          </div>

          <div className="thread">
            {thread.length === 0 && (
              <EmptyState
                title={query ? 'No matches' : `No chats with ${active.name} yet`}
                steps={query ? undefined : [
                  'Log in via the Agents menu (once per agent)',
                  'Chats sync here on their own — replies you send go to the real session',
                ]}
              />
            )}
            {thread.map((m) => (
              <MessageBubble key={m.id} message={m} onRetry={retryDelivery} />
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="composer">
            <TextField
              hideLabel
              label={`Message ${active.name}`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              placeholder={`Message ${active.name}…`}
            />
            <Button
              variant="primary"
              size="lg"
              onClick={send}
              disabled={sending || !input.trim()}
            >
              Send
            </Button>
          </div>
          <p className="status-line">{statusLine}</p>
          </>}
        </main>
      </div>
    </div>
  );
}
