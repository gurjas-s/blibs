import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { PROVIDERS, SEED_AGENTS, providerFor } from './providers';
import type { Agent, ChatMessage, LoginStatus } from './types';
import { cleanImportText, isIntroText } from './text';
import {
  applyTheme,
  readThemePreference,
  SYSTEM_THEME_QUERY,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './theme';
import SearchPanel from './SearchPanel';
import SettingsPanel from './SettingsPanel';
import {
  EMPTY_SEARCH_DEFAULTS,
  filtersFromDefaults,
  parseSearchQuery,
  type SearchCommand,
  type SearchDefaults,
} from './search';
import Onboarding from './Onboarding';
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
  updateRelayHarnesses,
} from './client';
import {
  HARNESSES,
  actionsFor,
  connectionFor,
  connectLinkFor,
  harnessName,
  latestAction,
  readConnectionState,
  resolveSetupStatus,
  setAssistantSetup,
  setHarnessEnabled,
  setSharedFolder,
  writeConnectionState,
} from './connections';
import type { ConnectionState } from './connections';
import { AgentListItem } from './components/AgentListItem';
import { Avatar } from './components/Avatar';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { CheckboxField } from './components/CheckboxField';
import { EmptyState } from './components/EmptyState';
import { MessageBubble } from './components/MessageBubble';
import { SectionLabel } from './components/SectionLabel';
import { SetupCard } from './components/SetupCard';
import { StatusPill } from './components/StatusPill';
import type { StatusTone } from './components/StatusPill';
import { TextField } from './components/TextField';
import { cx } from './components/cx';

const LS_MSGS = 'blibs-messages-v2';
const LS_AGENTS = 'blibs-agents-v2';
const LS_AUTOPULL = 'blibs-autopull-v1';
const LS_PULLSECS = 'blibs-pullsecs-v1';
const LS_ONBOARDING = 'blibs-onboarding-v1';
const LS_SEARCH = 'blibs-search-defaults-v1';
const ONBOARDING_DONE = 'done';

/** Search debounce in milliseconds. */
const SEARCH_DEBOUNCE_MS = 250;

/** The assistant whose chat the relay reads and answers. */
const RELAY_ASSISTANT_PROVIDER = 'muse';

/** The main pane that the shell shows. */
type View = 'chat' | 'results' | 'settings' | 'login' | 'connections';

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

function loadSearchDefaults(): SearchDefaults {
  const raw = load<Record<string, unknown>>(LS_SEARCH, {});
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    ...EMPTY_SEARCH_DEFAULTS,
    threadId: text(raw.threadId),
    from: text(raw.from),
    to: text(raw.to),
  };
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
  const [view, setView] = useState<View>('chat');
  const [searchDefaults, setSearchDefaults] = useState<SearchDefaults>(loadSearchDefaults);
  const [searchCommand, setSearchCommand] = useState<SearchCommand | null>(null);
  const [settingsReturn, setSettingsReturn] = useState<View>('chat');
  const [onboarded, setOnboarded] = useState(onboardingComplete);
  const [connections, setConnections] = useState<ConnectionState>(
    () => readConnectionState(agents.map((agent) => agent.id)),
  );
  const [loginStatuses, setLoginStatuses] = useState<Record<string, LoginStatus>>({});
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusLine, setStatusLine] = useState('Waiting for sync');
  const [lastPull, setLastPull] = useState<{ at: number; ok: boolean } | null>(null);
  const [autoPull, setAutoPull] = useState<boolean>(() => load(LS_AUTOPULL, true));
  const [pullSecs, setPullSecs] = useState<number>(() => load(LS_PULLSECS, 15));
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchId = useRef(0);
  const debounceTimer = useRef<number | null>(null);
  const pendingCaret = useRef(false);
  const lastHarnessReport = useRef('');

  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  const meta = providerFor(active);
  const parsedQuery = parseSearchQuery(query);
  const desktopAvailable = desktopLoginAvailable();
  const activeConnection = connectionFor(connections, active.id);
  const activeSetup = resolveSetupStatus(activeConnection, loginStatuses[active.id]);
  const activeActivity = actionsFor(connections, active.id);
  const lastActivity = activeActivity[0];
  const activeStatus = loginStatuses[active.id];
  const checking = activeStatus?.phase === 'loading' || activeStatus?.phase === 'opening';

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
    writeConnectionState(connections);
  }, [connections]);

  useEffect(() => {
    const relayAgent = agents.find((agent) => agent.provider === RELAY_ASSISTANT_PROVIDER);
    if (!relayAgent) return;
    const connection = connectionFor(connections, relayAgent.id);
    const report = HARNESSES.map((harness) => ({
      id: harness.id,
      name: harness.name,
      enabled: connection.harnesses[harness.id],
    }));
    const signature = JSON.stringify(report);
    if (signature === lastHarnessReport.current) return;
    lastHarnessReport.current = signature;
    void updateRelayHarnesses(report).catch(() => {
      // The next connection change reports again.
      lastHarnessReport.current = '';
    });
  }, [connections, agents]);
  useEffect(() => {
    localStorage.setItem(LS_AUTOPULL, JSON.stringify(autoPull));
  }, [autoPull]);
  useEffect(() => {
    localStorage.setItem(LS_PULLSECS, JSON.stringify(pullSecs));
  }, [pullSecs]);
  useEffect(() => {
    localStorage.setItem(LS_SEARCH, JSON.stringify(searchDefaults));
  }, [searchDefaults]);
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

  // A signed-in desktop session is the source of truth for the setup state.
  useEffect(() => {
    setConnections((current) => {
      let next = current;
      for (const agent of agents) {
        if (loginStatuses[agent.id]?.phase === 'signed-in') {
          next = setAssistantSetup(next, agent.id, 'connected');
        }
      }
      return next;
    });
  }, [loginStatuses, agents]);

  useEffect(() => {
    if (view !== 'login') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setView('chat');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view]);

  useEffect(() => {
    if (!contextOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contextOpen]);

  const thread = useMemo(() => {
    return [...(messages[active.id] ?? [])].sort((a, b) => a.ts - b.ts);
  }, [messages, active.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [thread.length, activeId]);

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
        const intro = isIntroText(text);
        const list = next[target] ?? [];
        const existing = list.find(m => m.historyId === it.id) ?? list.find(m => {
          // An introduction is also delivered to the vendor chat. Its echo
          // must not add a second bubble.
          if (intro && isIntroText(cleanImportText(m.text)) && cleanImportText(m.text) === text) return true;
          if (m.historyId || m.role !== role || cleanImportText(m.text) !== text) return false;
          // Imports use first-observed times. Delivery may occur long after a send or retry.
          return m.ts === it.ts || (m.via === 'tab' && it.ts >= m.ts);
        });
        if (existing) {
          if (intro && isIntroText(cleanImportText(existing.text))) continue;
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
            role: intro ? 'agent' : role,
            text,
            ts: Number(it.ts) || Date.now(),
            source: 'desktop',
            ...(intro ? { senderName: 'blibs' } : {}),
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
      /* proxy down — the status announcement already says so */
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

  function cancelPendingSearch(): void {
    if (debounceTimer.current === null) return;
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
  }

  /** Run the topbar query. A tag with no text runs no search. */
  function startSearch(ask: boolean): void {
    cancelPendingSearch();
    const parsed = parseSearchQuery(query);
    if (!parsed.text) return;
    searchId.current += 1;
    setSearchCommand({
      id: searchId.current,
      text: parsed.text,
      filters: filtersFromDefaults(searchDefaults, parsed.provider),
      ask,
    });
    setView('results');
    setContextOpen(false);
  }

  function submitSearch(): void {
    startSearch(false);
  }

  function exitSearch(): void {
    cancelPendingSearch();
    setQuery('');
    setView('chat');
  }

  function openSettings(): void {
    cancelPendingSearch();
    if (view !== 'settings') setSettingsReturn(view);
    setView('settings');
    setSidebarOpen(false);
    setContextOpen(false);
  }

  function closeSettings(): void {
    if (settingsReturn === 'results') {
      if (parsedQuery.text) {
        startSearch(false);
        return;
      }
      setView('chat');
      return;
    }
    setView(settingsReturn === 'settings' || settingsReturn === 'connections' ? 'chat' : settingsReturn);
  }

  const startSearchRef = useRef(startSearch);
  useEffect(() => { startSearchRef.current = startSearch; });

  // Type ahead: one search after the debounce. Tags alone run no search.
  useEffect(() => {
    if (!query.trim()) {
      setView('chat');
      return;
    }
    if (!parseSearchQuery(query).text) return;
    const timer = window.setTimeout(() => {
      debounceTimer.current = null;
      startSearchRef.current(false);
    }, SEARCH_DEBOUNCE_MS);
    debounceTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (debounceTimer.current === timer) debounceTimer.current = null;
    };
  }, [query]);

  // Cmd+F on macOS and Ctrl+F elsewhere focus the bar. In a chat, prefill its tag.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const field = searchInput.current;
      if (!field) return;
      event.preventDefault();
      field.focus();
      if (view === 'chat' && !query.trim()) {
        pendingCaret.current = true;
        setQuery(`#${active.provider} `);
      } else {
        field.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, query, active.provider]);

  useLayoutEffect(() => {
    if (!pendingCaret.current) return;
    pendingCaret.current = false;
    const field = searchInput.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [query]);

  function markOnboarded(): void {
    try {
      localStorage.setItem(LS_ONBOARDING, ONBOARDING_DONE);
    } catch {
      // The choice still applies for this window.
    }
    setOnboarded(true);
  }

  function startChat(): void {
    markOnboarded();
    setView('chat');
  }

  function connectAnother(): void {
    markOnboarded();
    setView('login');
  }

  function openConnections(): void {
    cancelPendingSearch();
    setSidebarOpen(false);
    setContextOpen(false);
    setView('connections');
  }

  function toggleHarness(assistantId: string, harnessId: (typeof HARNESSES)[number]['id'], enabled: boolean): void {
    setConnections((current) => setHarnessEnabled(current, assistantId, harnessId, enabled));
  }

  function changeFolder(folder: string): void {
    setConnections((current) => setSharedFolder(current, folder));
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
        setLoginStatuses((current) => ({ ...current, [vendorId]: status }));
      })
      .catch((error: unknown) => reportLoginError(vendorId, error));
  }

  function cancelLogin(vendorId: string): void {
    cancelVendorLogin(vendorId)
      .then((status) => {
        setLoginStatuses((current) => ({ ...current, [vendorId]: status }));
      })
      .catch((error: unknown) => reportLoginError(vendorId, error));
  }

  function checkLogin(vendorId: string): void {
    checkVendorLogin(vendorId)
      .then((status) => {
        setLoginStatuses((current) => ({ ...current, [vendorId]: status }));
      })
      .catch((error: unknown) => reportLoginError(vendorId, error));
  }

  const pill: { tone: StatusTone; label: string } = !lastPull
    ? { tone: 'idle', label: 'Waiting for sync' }
    : lastPull.ok
      ? { tone: 'live', label: `Synced ${clock(lastPull.at)}` }
      : { tone: 'down', label: 'Backend unreachable' };

  if (!onboarded || view === 'connections') {
    return (
      <Onboarding
        assistants={PROVIDERS}
        harnesses={HARNESSES}
        state={connections}
        onToggleHarness={toggleHarness}
        onChangeFolder={changeFolder}
        onConnectAnother={connectAnother}
        onStart={startChat}
        onBack={view === 'connections' ? () => setView('chat') : undefined}
      />
    );
  }

  const connected = activeSetup === 'connected';
  const setupError = activeStatus?.phase === 'error' ? activeStatus.message : undefined;
  const layoutClass = cx(
    'layout',
    sidebarOpen && 'sidebar-open',
    view === 'chat' && contextOpen && 'context-open',
    view !== 'chat' && 'layout--wide',
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-start">
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
        </div>
        <div className="topbar-main">
          <div className="search" role="search">
            <TextField
              hideLabel
              inputRef={searchInput}
              label="Search all conversations"
              title="Type #muse, #dots, #grok, or #custom to filter by provider."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitSearch();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  exitSearch();
                }
              }}
              placeholder="Search all conversations…"
              maxLength={1000}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="topbar-actions">
            <StatusPill tone={pill.tone} title={statusLine}>
              {pill.label}
            </StatusPill>
          </div>
        </div>
      </header>

      <div className={layoutClass}>
        <aside className="sidebar" id="agent-sidebar" aria-label="Assistants">
          <div className="side-head">
            <SectionLabel>Assistants</SectionLabel>
            <Button
              variant="ghost"
              size="sm"
              className="side-gear"
              aria-label="Settings"
              title="Settings"
              onClick={openSettings}
            >
              <span aria-hidden="true">⚙</span>
            </Button>
          </div>
          {agents.map((a) => {
            const setup = resolveSetupStatus(connectionFor(connections, a.id), loginStatuses[a.id]);
            const latest = latestAction(connections, a.id);
            return (
              <AgentListItem
                key={a.id}
                agent={a}
                active={a.id === activeId}
                setup={setup}
                stateLabel={setup === 'setup'
                  ? 'Setup'
                  : a.lastSyncAt ? timeAgo(a.lastSyncAt) : 'Connected'}
                detail={setup === 'setup'
                  ? 'Not connected yet'
                  : latest ? latest.title : 'No harness activity yet'}
                onSelect={(id) => {
                  cancelPendingSearch();
                  setActiveId(id);
                  setQuery('');
                  setView('chat');
                  setSidebarOpen(false);
                  setContextOpen(false);
                }}
              />
            );
          })}
          <div className="side-foot">
            <Button
              variant="secondary"
              size="lg"
              className="side-nav"
              onClick={openConnections}
            >
              Connections
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="side-nav"
              onClick={() => {
                cancelPendingSearch();
                setView('login');
                setSidebarOpen(false);
                setContextOpen(false);
              }}
            >
              Agents
            </Button>
          </div>
        </aside>

        <main className="main">
          {view === 'login' ? (
            <LoginScreen
              vendors={PROVIDERS}
              statuses={loginStatuses}
              desktopAvailable={desktopAvailable}
              onBack={() => setView('chat')}
              onSignIn={startLogin}
              onCancel={cancelLogin}
              onCheck={checkLogin}
            />
          ) : view === 'settings' ? (
            <SettingsPanel
              theme={theme}
              onThemeChange={setTheme}
              defaults={searchDefaults}
              onDefaultsChange={setSearchDefaults}
              canAsk={Boolean(parsedQuery.text)}
              onAsk={() => startSearch(true)}
              autoPull={autoPull}
              onAutoPullChange={setAutoPull}
              pullSecs={pullSecs}
              onPullSecsChange={setPullSecs}
              onBack={closeSettings}
            />
          ) : view === 'results' && searchCommand ? (
            <SearchPanel command={searchCommand} />
          ) : <>
            <div className="chat-head">
              <div className="chat-identity">
                <Avatar name={active.name} active={connected} />
                <h1>{active.name}</h1>
                <StatusPill tone={connected ? 'live' : 'idle'}>
                  {connected ? 'Connected' : 'Setup'}
                </StatusPill>
              </div>
              <div className="chat-actions">
                <Button variant="secondary" size="sm" onClick={openConnections}>
                  Edit tools
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="context-toggle"
                  aria-expanded={contextOpen}
                  aria-controls="assistant-context"
                  onClick={() => setContextOpen((open) => !open)}
                >
                  Context
                </Button>
              </div>
            </div>

            {connected ? (
              <>
                <div
                  className="thread"
                  role="log"
                  aria-label={`Messages with ${active.name}`}
                  tabIndex={0}
                >
                  <div className="thread-content">
                    {thread.length === 0 && (
                      <EmptyState
                        title={`No messages with ${active.name} yet`}
                        steps={['Use Agents to sync chats.', 'Send a message to start a new turn.']}
                      />
                    )}
                    {thread.map((m) => (
                      <MessageBubble key={m.id} message={m} agentName={active.name} onRetry={retryDelivery} />
                    ))}
                    <div ref={bottomRef} />
                  </div>
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
              </>
            ) : (
              <>
                <div className="setup-wrap">
                  <SetupCard
                    key={active.id}
                    assistantName={active.name}
                    connectLink={connectLinkFor(active.id)}
                    desktopAvailable={desktopAvailable}
                    checking={checking}
                    error={setupError}
                    onCheck={() => checkLogin(active.id)}
                    onOpen={() => startLogin(active.id)}
                  />
                </div>
                <div className="composer composer--disabled">
                  <TextField
                    hideLabel
                    label={`Message ${active.name}`}
                    value=""
                    disabled
                    readOnly
                    aria-describedby="composer-reason"
                    placeholder={`Connect ${active.name} to send messages`}
                  />
                  <Button variant="primary" size="lg" disabled>
                    Send
                  </Button>
                </div>
                <p className="composer-reason" id="composer-reason">
                  Connect {active.name} above before you send a message.
                </p>
              </>
            )}
            <p className="sr-only" role="status">{statusLine}</p>
          </>}
        </main>

        {view === 'chat' && (
          <aside
            className={cx('context', contextOpen && 'context--open')}
            id="assistant-context"
            aria-label={`Context for ${active.name}`}
          >
            <div className="context-head">
              <SectionLabel>Context</SectionLabel>
              <Button
                variant="ghost"
                size="sm"
                className="context-close"
                aria-label="Close context"
                onClick={() => setContextOpen(false)}
              >
                Close
              </Button>
            </div>

            <Card className="harness-preview">
              <div className={cx('preview-screen', !lastActivity && 'preview-screen--empty')}>
                {lastActivity ? (
                  <>
                    <span className="preview-title">{lastActivity.title}</span>
                    <span className="preview-detail">{lastActivity.detail}</span>
                  </>
                ) : (
                  <span>No harness run yet</span>
                )}
              </div>
              <p className="preview-caption">
                {lastActivity
                  ? `${harnessName(lastActivity.harness)} · ${connections.folder}`
                  : `Shared folder · ${connections.folder}`}
              </p>
            </Card>

            <div className="context-section">
              <SectionLabel>Harnesses {active.name} can use</SectionLabel>
              {HARNESSES.map((harness) => (
                <div className="context-row" key={harness.id}>
                  <span>{harness.name}</span>
                  <CheckboxField
                    variant="switch"
                    checked={activeConnection.harnesses[harness.id]}
                    label={`${harness.name} for ${active.name}`}
                    onChange={(event) => toggleHarness(active.id, harness.id, event.target.checked)}
                  />
                </div>
              ))}
            </div>

            <div className="context-section">
              <SectionLabel>Recent activity</SectionLabel>
              {activeActivity.length === 0 ? (
                <p className="context-empty">No harness activity yet.</p>
              ) : (
                <ul className="activity-list">
                  {activeActivity.slice(0, 5).map((action) => (
                    <li className="context-row" key={action.id}>
                      <span className="activity-title">{action.title}</span>
                      <time
                        className="activity-time"
                        dateTime={new Date(action.at).toISOString()}
                        title={new Date(action.at).toLocaleString()}
                      >
                        {timeAgo(action.at)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
