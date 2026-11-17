import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { PROVIDERS, SEED_AGENTS, providerFor } from './providers';
import type { Agent, ChatMessage, LoginStatus } from './types';
import { cleanImportText } from './text';
import {
  applyTheme,
  readThemePreference,
  SYSTEM_THEME_QUERY,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './theme';
import SearchPanel, { type SearchRunRequest } from './SearchPanel';
import Onboarding, { type OnboardingResult } from './Onboarding';
import LoginScreen from './LoginScreen';
import {
  cancelVendorLogin,
  checkVendorLogin,
  desktopLoginAvailable,
  fetchLoginStatus,
  openVendorLogin,
  subscribeLoginStatus,
} from './desktop';
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
const LS_ONBOARDING = 'blibs-onboarding-v1';
const ONBOARDING_DONE = 'done';

/** Where the topbar search applies. */
type SearchScope = 'chat' | 'all';

function onboardingComplete(): boolean {
  try {
    return localStorage.getItem(LS_ONBOARDING) === ONBOARDING_DONE;
  } catch {
    return false;
  }
}

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
  const [scope, setScope] = useState<SearchScope>('chat');
  const [searchRequest, setSearchRequest] = useState<SearchRunRequest | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [onboarded, setOnboarded] = useState(onboardingComplete);
  const [loginStatuses, setLoginStatuses] = useState<Record<string, LoginStatus>>({});
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusLine, setStatusLine] = useState('Waiting for sync');
  const [lastPull, setLastPull] = useState<{ at: number; ok: boolean } | null>(null);
  const [autoPull, setAutoPull] = useState<boolean>(() => load(LS_AUTOPULL, true));
  const [pullSecs, setPullSecs] = useState<number>(() => load(LS_PULLSECS, 15));
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchId = useRef(0);

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
  useLayoutEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
    if (theme !== 'system') return;
    const query = window.matchMedia(SYSTEM_THEME_QUERY);
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => subscribeLoginStatus((status) => {
    setLoginStatuses((current) => ({ ...current, [status.vendorId]: status }));
  }), []);

  useEffect(() => {
    if (!desktopLoginAvailable()) return;
    for (const vendor of PROVIDERS) {
      fetchLoginStatus(vendor.id)
        .then((status) => {
          if (status) {
            setLoginStatuses((current) => ({ ...current, [status.vendorId]: status }));
          }
        })
        .catch(() => {
          // The login screen reports an unavailable bridge when used.
        });
    }
  }, []);

  useEffect(() => {
    if (!showLogin) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowLogin(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showLogin]);

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
          : 'Up to date',
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
      setStatusLine(`Sent to ${meta.product}`);
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
      setStatusLine('Re-queued');
    } catch {
      setStatusLine('Retry failed — is the backend running?');
    }
  }

  /** Choose a search scope without running a search or clearing the text. */
  function changeScope(next: SearchScope): void {
    setScope(next);
    setShowLogin(false);
    setSidebarOpen(false);
    if (next === 'chat') setSearchRequest(null);
  }

  /** Submit the topbar query. The chat scope filters as the user types. */
  function submitSearch(): void {
    if (scope !== 'all') return;
    const text = query.trim();
    if (!text) return;
    setShowLogin(false);
    searchId.current += 1;
    setSearchRequest({ id: searchId.current, text });
  }

  /** Forget a search request after the panel runs it, so a scope change is quiet. */
  const handleSearchRequest = useCallback((id: number) => {
    setSearchRequest((current) => (current?.id === id ? null : current));
  }, []);

  function finishOnboarding(result: OnboardingResult): void {
    try {
      localStorage.setItem(LS_ONBOARDING, ONBOARDING_DONE);
    } catch {
      // The choice still applies for this window.
    }
    setOnboarded(true);
    if (result.openLogin) {
      changeScope('chat');
      setShowLogin(true);
      if (result.vendorId) startLogin(result.vendorId);
    }
  }

  function reportLoginError(vendorId: string, error: unknown): void {
    setLoginStatuses((current) => ({
      ...current,
      [vendorId]: {
        vendorId,
        phase: 'error',
        message: String((error as Error)?.message || error),
        mock: false,
      },
    }));
  }

  function startLogin(vendorId: string): void {
    openVendorLogin(vendorId)
      .then((status) => {
        setLoginStatuses((current) => ({ ...current, [status.vendorId]: status }));
      })
      .catch((error: unknown) => reportLoginError(vendorId, error));
  }

  function cancelLogin(vendorId: string): void {
    cancelVendorLogin(vendorId)
      .then((status) => {
        setLoginStatuses((current) => ({ ...current, [status.vendorId]: status }));
      })
      .catch((error: unknown) => reportLoginError(vendorId, error));
  }

  function checkLogin(vendorId: string): void {
    checkVendorLogin(vendorId)
      .then((status) => {
        setLoginStatuses((current) => ({ ...current, [status.vendorId]: status }));
      })
      .catch((error: unknown) => reportLoginError(vendorId, error));
  }

  const pill: { tone: StatusTone; label: string } = !lastPull
    ? { tone: 'idle', label: 'Waiting for sync' }
    : lastPull.ok
      ? { tone: 'live', label: `Synced ${clock(lastPull.at)}` }
      : { tone: 'down', label: 'Backend unreachable' };

  if (!onboarded) return <Onboarding onFinish={finishOnboarding} />;

  return (
    <div className="shell">
      <header className="topbar">
        <Button
          variant="ghost"
          size="sm"
          className="sidebar-toggle"
          aria-expanded={sidebarOpen}
          aria-controls="agent-sidebar"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          Chats
        </Button>
        <div className="brand">
          <span className="mark" aria-hidden="true">b</span>
          <strong>blibs</strong>
        </div>
        <div className="search" role="search">
          <TextField
            hideLabel
            label={scope === 'all' ? 'Search all conversations' : `Search ${active.name}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              submitSearch();
            }}
            placeholder={scope === 'all' ? 'Search all conversations…' : `Search ${active.name}…`}
            maxLength={1000}
            autoComplete="off"
          />
          <SelectField
            hideLabel
            label="Search scope"
            className="scope-select"
            value={scope}
            onChange={(e) => changeScope(e.target.value as SearchScope)}
          >
            <option value="chat">This chat</option>
            <option value="all">All conversations</option>
          </SelectField>
        </div>
        <div className="topbar-actions">
          <SelectField
            hideLabel
            label="Theme"
            className="theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemePreference)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </SelectField>
          <StatusPill tone={pill.tone} title={statusLine}>
            {pill.label}
          </StatusPill>
        </div>
      </header>

      <div className={sidebarOpen ? 'layout sidebar-open' : 'layout'}>
        <aside className="sidebar" id="agent-sidebar" aria-label="Chats">
          <SectionLabel>Chats</SectionLabel>
          {agents.map((a) => (
            <AgentListItem
              key={a.id}
              agent={a}
              active={a.id === activeId}
              syncLabel={a.lastSyncAt ? `Synced ${timeAgo(a.lastSyncAt)}` : 'Not synced'}
              onSelect={(id) => {
                setActiveId(id);
                changeScope('chat');
              }}
            />
          ))}
          <div className="side-foot">
            <Button
              variant="secondary"
              size="lg"
              className="history-nav"
              onClick={() => {
                changeScope('chat');
                setShowLogin(true);
              }}
            >
              Agents and sign-in
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
          </div>
        </aside>

        <main className="main">
          {showLogin ? (
            <LoginScreen
              vendors={PROVIDERS}
              statuses={loginStatuses}
              desktopAvailable={desktopLoginAvailable()}
              onBack={() => setShowLogin(false)}
              onSignIn={startLogin}
              onCancel={cancelLogin}
              onCheck={checkLogin}
            />
          ) : scope === 'all' ? (
            <SearchPanel
              query={query}
              request={searchRequest}
              onRequestHandled={handleSearchRequest}
            />
          ) : <>
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

          <div
            className="thread"
            role="log"
            aria-label={`Messages with ${active.name}`}
            tabIndex={0}
          >
            {thread.length === 0 && (
              <EmptyState
                title={query ? 'No matches' : `No messages with ${active.name} yet`}
                steps={query ? undefined : ['Use Agents and sign-in to sync chats.']}
              />
            )}
            {thread.map((m) => (
              <MessageBubble key={m.id} message={m} agentName={active.name} onRetry={retryDelivery} />
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
          <p className="status-line" role="status">{statusLine}</p>
          </>}
        </main>
      </div>
    </div>
  );
}
