import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryMessage } from './history.js';
import { DEFAULT_DISCOVERY_ROOT } from './relay-defaults.js';
import type { Harness, HarnessRun, HarnessStartOptions } from './harness/types.js';
import { extractMentionBody, isUserTurn, sanitizeReply, startsWithMention } from './harness/mention.js';
import { stripVendorLabel } from '../shared/vendor-label.js';
import { BLIBS_MENTION, isBlibsMention, isIntroMessage, introMessage } from './harness/intro.js';
import type { HarnessChoice } from './harness/intro.js';
import { harnessMessage } from './harness/message.js';
import {
  buildProjectChoices,
  CHOICES_HEADER,
  PROJECT_CHOICE_LIMIT,
  formatProjectList,
  formatModelChoices,
  projectSelectionFormat,
  sessionCommands,
  unknownProjectNote,
  isChoicesMessage,
} from './harness/project-reply.js';
import type { ProjectChoice, ReplyOptions } from './harness/project-reply.js';
import { HARNESS_KINDS, harnessKind } from './harness/registry.js';
import {
  RELAY_PROCESSED_LIMIT,
  RELAY_SESSION_LIMIT,
  RELAY_STATE_VERSION,
  RELAY_THREAD_LIMIT,
  SESSION_NAME,
  parseNamedSessions,
  parseHarnesses,
  parseModel,
  parseRelayRun,
  parseSessions,
  parseStringArray,
  readRelayStateFile,
} from './relay-state.js';
import type { NamedSession, RelayRunState, RelayState } from './relay-state.js';
import {
  canonicalDir,
  PROJECT_LIMIT,
  listProjects,
  matchProject,
  projectsRoot,
  sessionKey,
  sessionKeyPrefix,
  taskAfterUnknownProject,
} from './harness/projects.js';

export const RELAY_QUEUE_LIMIT = 20;
export const RELAY_PROVIDER = 'muse';
/** Environment override for the harness command. Tests and e2e stub the harness with it. */
export const RELAY_COMMAND_ENV = 'BLIBS_RELAY_COMMAND';
/** Environment override for the projects directory. */
export const RELAY_PROJECTS_DIR_ENV = 'BLIBS_RELAY_PROJECTS_DIR';
/** Length limit for one stored or env harness command. */
const RELAY_COMMAND_LIMIT = 2000;
/** Window that treats the same introduction text in one thread as a re-scrape. */
const TRIGGER_DEDUPE_MS = 2 * 60_000;
const TRIGGER_DEDUPE_LIMIT = 500;
/** Keep the full session list short enough to send in one chat message. */
const PROJECT_SESSION_LIMIT = 20;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_HOSTS: Record<string, string> = { muse: 'muse.ai', dots: 'chatgpt.com', grok: 'grok.com' };
const CHECKOUT_ROOT_DEPTH = 8;

export interface RelayConfig {
  enabled: boolean;
  provider: string;
  /** Harness id from the registry in `server/harness/registry.ts`. */
  harnessId: string;
  command: string;
  cwd: string;
  /** Default harness model in provider/model form. Empty means the harness default. */
  model?: string;
  /** Directory whose immediate subfolders are the projects. */
  discoveryRoot: string;
}

export interface RelayStatus {
  enabled: boolean;
  provider: string;
  harness: { id: string; command: string; cwd: string; model?: string };
  /** Harnesses supported by the configured provider. */
  harnesses: HarnessChoice[];
  modelDefaults: Array<{ id: string; name: string; model?: string }>;
  discoveryRoot: string;
  projects: Array<{ name: string; token: string }>;
  pending: number;
  running: boolean;
  processed: number;
  watermark: number;
  sessions: number;
  lastRun: RelayRunState | null;
}

export type ProjectCreation =
  | { kind: 'created'; token: string }
  | { kind: 'invalid' | 'conflict' | 'failed'; error: string };

interface RelayItem {
  id: string;
  provider: string;
  threadId: string;
  /** Empty requests the project list. Null clears the chat context. */
  body: string | null;
}

type SessionRequest = { kind: 'new'; name: string } | { kind: 'resume'; selector: string };

interface RelayWork {
  item: RelayItem;
  task: string;
  projectPath: string;
  session: SessionRequest;
  model?: string;
}

interface ActiveWork {
  item: RelayItem;
  startedAt: number;
  catalog?: AbortController;
  run?: HarnessRun;
}

interface PendingProjectTask {
  id: string;
  body: string;
  choices: ProjectChoice[];
}

export interface RelayServiceOptions {
  config: RelayConfig;
  harness: Harness;
  stateDir: string;
  enqueue: (provider: string, text: string, threadId?: string) => void;
  /** Record one blibs-authored reply in the chat history. */
  announce?: (provider: string, text: string, threadId?: string, triggerId?: string) => void;
  knownThreads?: string[];
  threadHasUser?: (provider: string, threadId: string) => boolean;
}

export function findCheckoutRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth < CHECKOUT_ROOT_DEPTH; depth++) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === 'blibs') return dir;
    } catch { /* keep looking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function inside(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function safeHarnessCwd(requested: string, dataDir: string): string {
  const checkout = findCheckoutRoot(MODULE_DIR);
  if (!checkout || !inside(requested, checkout)) return requested;
  const fallback = path.join(dataDir, 'harness');
  return inside(fallback, checkout) ? path.join(os.tmpdir(), 'blibs-harness') : fallback;
}

export function buildRelayConfig(dataDir: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  const envCommand = process.env[RELAY_COMMAND_ENV]?.trim();
  const envProjectsDir = process.env[RELAY_PROJECTS_DIR_ENV]?.trim();
  // The registry owns the harness default. An explicit command override wins
  // over the environment, and an unknown harness id falls back to the default.
  const kind = harnessKind(overrides.harnessId);
  const config: RelayConfig = {
    enabled: true,
    provider: RELAY_PROVIDER,
    cwd: path.join(dataDir, 'harness'),
    ...overrides,
    discoveryRoot: overrides.discoveryRoot ?? envProjectsDir ?? DEFAULT_DISCOVERY_ROOT,
    harnessId: kind.id,
    command: overrides.command ?? (envCommand ? envCommand.slice(0, RELAY_COMMAND_LIMIT) : kind.defaultCommand),
  };
  return {
    ...config,
    cwd: canonicalDir(safeHarnessCwd(path.resolve(config.cwd), dataDir)),
    discoveryRoot: canonicalDir(projectsRoot(config.discoveryRoot)),
  };
}

export function isTimeLabel(text: string): boolean {
  return /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(text.trim());
}

export function buildPrompt(task: string): string {
  return task.trim();
}

// A signed-out vendor page scrapes marketing text, so its root is not a chat.
// An unknown provider has no host to check, so any thread id is accepted.
function providerThreadUrl(provider: string, threadId: string): URL | null {
  const host = PROVIDER_HOSTS[provider];
  if (!host) return null;
  try {
    const url = new URL(threadId);
    return url.protocol === 'https:' && url.hostname === host ? url : null;
  } catch {
    return null;
  }
}

export function isProviderThread(provider: string, threadId: string): boolean {
  if (!PROVIDER_HOSTS[provider]) return true;
  return providerThreadUrl(provider, threadId) !== null;
}

export function isConversationThread(provider: string, threadId: string): boolean {
  const url = providerThreadUrl(provider, threadId);
  if (!url) return !PROVIDER_HOSTS[provider];
  return url.pathname !== '/' && url.pathname !== '';
}

export class InvalidProjectsFolder extends Error {}

export class RelayService {
  private config: RelayConfig;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly harness: Harness;
  private readonly enqueueReply: (provider: string, text: string, threadId?: string) => void;
  private readonly announceReply: (provider: string, text: string, threadId?: string, triggerId?: string) => void;
  private readonly threadHasUser: (provider: string, threadId: string) => boolean;
  private readonly state: RelayState;
  private readonly knownThreads: Set<string>;
  private readonly queue: RelayItem[] = [];
  private readonly pendingProjectTasks = new Map<string, PendingProjectTask>();
  /** Trigger text per thread. A re-scraped message gets a new message id. */
  private readonly recentTriggers = new Map<string, number>();
  private readonly workQueue: RelayWork[] = [];
  private readonly active = new Map<string, ActiveWork>();
  private closed = false;

  constructor(options: RelayServiceOptions) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.stateFile = path.join(options.stateDir, 'relay-state.json');
    this.harness = options.harness;
    this.enqueueReply = options.enqueue;
    this.announceReply = options.announce ?? (() => {});
    this.threadHasUser = options.threadHasUser ?? (() => false);
    if (this.config.enabled) fs.mkdirSync(this.config.cwd, { recursive: true });

    const loaded = this.loadState();
    this.state = loaded
      ? loaded
      : {
          version: RELAY_STATE_VERSION,
          watermark: Date.now(),
          processed: [],
          threads: [],
          sessions: {},
          namedSessions: [],
          discoveryRoot: canonicalDir(options.config.discoveryRoot),
          modelDefaults: options.config.model ? { [options.config.harnessId]: options.config.model } : {},
          harnesses: [],
          runs: 0,
          lastRun: null,
        };
    if (loaded) this.config = { ...this.config, discoveryRoot: loaded.discoveryRoot };
    this.knownThreads = new Set([...(options.knownThreads ?? []), ...this.state.threads].slice(-RELAY_THREAD_LIMIT));
    this.state.threads = [...this.knownThreads];
    this.interruptLastRun('interrupted by restart');
    // No watermark is written on a disabled start, so stored rows stay backlog.
    if (!loaded && this.config.enabled) this.save();
  }

  private loadState(): RelayState | null {
    const raw = readRelayStateFile(this.stateFile);
    if (!raw) return null;
    const root = typeof raw.discoveryRoot === 'string' && raw.discoveryRoot.trim()
      ? raw.discoveryRoot
      : this.config.discoveryRoot;
    const modelDefaults: RelayState['modelDefaults'] = {};
    for (const { id } of HARNESS_KINDS) {
      // Older builds stored their built-in OpenCode model as if it were a user setting.
      const legacy = id === 'opencode' && raw.model !== 'opencode-go/beam-free' ? raw.model : undefined;
      const configured = id === this.config.harnessId ? this.config.model : undefined;
      const model = parseModel(raw.modelDefaults ? raw.modelDefaults[id] : legacy ?? configured);
      if (model) modelDefaults[id] = model;
    }
    return {
      version: RELAY_STATE_VERSION,
      watermark: typeof raw.watermark === 'number' && Number.isFinite(raw.watermark) ? raw.watermark : Date.now(),
      processed: parseStringArray(raw.processed, RELAY_PROCESSED_LIMIT),
      threads: parseStringArray(raw.threads, RELAY_THREAD_LIMIT),
      sessions: parseSessions(raw.sessions),
      namedSessions: parseNamedSessions(raw.namedSessions),
      discoveryRoot: canonicalDir(projectsRoot(root)),
      modelDefaults,
      harnesses: parseHarnesses(raw.harnesses),
      runs: typeof raw.runs === 'number' && raw.runs >= 0 ? raw.runs : 0,
      lastRun: parseRelayRun(raw.lastRun),
    };
  }

  private writeState(state: RelayState): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const staging = `${this.stateFile}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(state, null, 2));
    fs.renameSync(staging, this.stateFile);
  }

  private save(): void {
    try { this.writeState(this.state); } catch { /* the next write retries */ }
  }

  /** Turn a running last run into an error record. True when the record changed. */
  private interruptLastRun(error: string): boolean {
    const last = this.state.lastRun;
    if (last?.state !== 'running') return false;
    this.state.lastRun = { state: 'error', messageId: last.messageId, startedAt: last.startedAt, endedAt: Date.now(), error };
    return true;
  }

  private log(event: string, messageId: string, details: Record<string, string | number | boolean | null> = {}): void {
    console.info(JSON.stringify({ time: new Date().toISOString(), component: 'blibs-relay', event, messageId, ...details }));
  }

  private accepts(message: HistoryMessage): boolean {
    if (!this.config.enabled || this.closed) return false;
    if (message.role !== 'agent' && message.role !== 'user') return false;
    if (message.provider.toLowerCase() !== this.config.provider) return false;
    if (isTimeLabel(message.text)) return false;
    if (!isProviderThread(this.config.provider, message.threadId)) return false;
    // A root path is the landing page until the conversation has a user turn.
    if (!isConversationThread(this.config.provider, message.threadId)
      && !this.threadHasUser(this.config.provider, message.threadId)) return false;
    if (this.state.processed.includes(message.id)) return false;
    // Muse can stamp several rows in one scrape with the same time. Allow the
    // equal stamp so a /clear and the next trigger in one batch both run.
    return message.ts >= this.state.watermark;
  }

  private remember(message: HistoryMessage): void {
    this.state.processed.push(message.id);
    if (this.state.processed.length > RELAY_PROCESSED_LIMIT) this.state.processed.splice(0, this.state.processed.length - RELAY_PROCESSED_LIMIT);
    this.state.watermark = Math.max(this.state.watermark, message.ts);
  }

  private rememberThread(threadId: string): void {
    this.knownThreads.add(threadId);
    const threads = [...this.knownThreads];
    if (threads.length > RELAY_THREAD_LIMIT) {
      const oldest = threads[0];
      this.knownThreads.delete(oldest);
      this.pendingProjectTasks.delete(oldest);
      const prefix = sessionKeyPrefix(oldest);
      for (const key of Object.keys(this.state.sessions)) {
        if (key.startsWith(prefix)) delete this.state.sessions[key];
      }
    }
    this.state.threads = [...this.knownThreads].slice(-RELAY_THREAD_LIMIT);
  }

  private storedSession(threadId: string, projectPath: string): string | undefined {
    return this.state.sessions[sessionKey(threadId, projectPath)];
  }

  private sessionsFor(threadId: string, projectPath: string): NamedSession[] {
    const scope = sessionKey(threadId, projectPath);
    const named = this.state.namedSessions.filter((session) => session.scope === scope);
    const id = this.storedSession(threadId, projectPath);
    return id ? [{ scope, id, name: 'Default' }, ...named] : named;
  }

  private sessionList(sessions: NamedSession[], note: string, token: string): string {
    return [
      CHOICES_HEADER, '', note, ...sessions.map(({ name }) => `- ${name}`), '',
      ...sessionCommands(this.harness.mention, `$${token}`),
    ].join('\n');
  }

  private showSessions(item: RelayItem, project: ProjectChoice, startedAt: number): void {
    const sessions = this.sessionsFor(item.threadId, project.path);
    const note = sessions.length ? `Sessions for $${project.token}:` : `No sessions for $${project.token} in this chat.`;
    this.finishChoices(item, this.sessionList(sessions, note, project.token), startedAt);
  }

  /** Resolve a saved session or prepare to save the ID OpenCode creates. */
  private resolveSession(work: RelayWork, token: string): Pick<HarnessStartOptions, 'sessionId' | 'onSessionCreated'> | undefined {
    const { item, projectPath, session } = work;
    const sessions = this.sessionsFor(item.threadId, projectPath);
    if (session?.kind === 'new') {
      if (sessions.some(({ name }) => name.toLowerCase() === session.name.toLowerCase())
        || session.name.toLowerCase() === 'default') {
        this.finishChoices(item, this.sessionList(sessions, 'Choose a different session name.', token), Date.now());
        return;
      }
      if (sessions.length >= PROJECT_SESSION_LIMIT || this.state.namedSessions.length >= RELAY_SESSION_LIMIT) {
        this.finishChoices(item, this.sessionList(sessions, 'The session limit has been reached.', token), Date.now());
        return;
      }
      return { onSessionCreated: (id) => {
        if (this.closed) return;
        if (this.state.namedSessions.length >= RELAY_SESSION_LIMIT) throw new Error('The session limit has been reached.');
        if (this.state.namedSessions.some((entry) => entry.id === id) || Object.values(this.state.sessions).includes(id)) {
          throw new Error('OpenCode returned an existing session ID.');
        }
        const named = { scope: sessionKey(item.threadId, projectPath), id, name: session.name };
        const namedSessions = [...this.state.namedSessions, named];
        this.writeState({ ...this.state, namedSessions });
        this.state.namedSessions = namedSessions;
        this.announceSession(item, session.name, token);
      } };
    }
    // Keep ID selectors valid for commands sent before session names were shown.
    const selected = sessions.find(({ name }) => name.toLowerCase() === session.selector.toLowerCase())
      ?? sessions.find(({ id }) => id === session.selector);
    if (!selected) {
      const note = 'That session is unavailable for this chat and project.';
      this.finishChoices(item, this.sessionList(sessions, note, token), Date.now());
      return;
    }
    this.announceSession(item, selected.name, token);
    return { sessionId: selected.id };
  }

  private announceSession(item: RelayItem, name: string, token: string): void {
    const text = `${CHOICES_HEADER}\n\nActive session for $${token}: ${name}.`;
    if (!this.tellChoices(item, text)) throw new Error('Could not queue the session notice.');
  }

  private choiceOptions(): ReplyOptions {
    return {
      mention: this.harness.mention,
      root: this.config.discoveryRoot,
    };
  }

  private harnessEnabled(): boolean {
    return this.state.harnesses.find((choice) => choice.id === this.config.harnessId)?.enabled ?? true;
  }

  harnesses(): HarnessChoice[] {
    const kind = harnessKind(this.config.harnessId);
    return [{ id: kind.id, name: kind.name, enabled: this.config.enabled && this.harnessEnabled() }];
  }

  updateHarnesses(reported: HarnessChoice[]): RelayStatus {
    const choice = reported.find((choice) => choice.id === this.config.harnessId);
    if (!choice) return this.status();
    const harnesses = [{ ...choice, name: harnessKind(this.config.harnessId).name }];
    this.writeState({ ...this.state, harnesses });
    this.state.harnesses = harnesses;
    return this.status();
  }

  /** Record and send one introduction reply. It is not a harness run. */
  private announceIntro(message: HistoryMessage): void {
    const text = introMessage(this.harnesses());
    // sanitizeReply would strip the example tag from the suggested first task.
    this.tellProvider(message, text, false);
    try {
      this.announceReply(message.provider, text, message.threadId, message.id);
    } catch { /* the next @blibs message retries */ }
  }

  /** Change the projects directory and the harness model. Omit a field to keep it. */
  updateProjects(discoveryRoot?: string, model?: string | null, harnessId = this.config.harnessId): RelayStatus {
    let resolved = this.state.discoveryRoot;
    if (discoveryRoot !== undefined) {
      try {
        resolved = projectsRoot(discoveryRoot.trim());
        fs.mkdirSync(resolved, { recursive: true });
        resolved = fs.realpathSync(resolved);
        fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
      } catch {
        throw new InvalidProjectsFolder('Could not save the projects folder. Enter a path to an accessible directory.');
      }
    }
    const modelDefaults = { ...this.state.modelDefaults };
    if (model === null) delete modelDefaults[harnessId];
    else if (model !== undefined) modelDefaults[harnessId] = model;
    this.writeState({ ...this.state, discoveryRoot: resolved, modelDefaults });
    if (resolved !== this.state.discoveryRoot) this.pendingProjectTasks.clear();
    this.state.discoveryRoot = resolved;
    this.state.modelDefaults = modelDefaults;
    this.config = { ...this.config, discoveryRoot: resolved };
    return this.status();
  }

  createProject(name: unknown): ProjectCreation {
    if (typeof name !== 'string' || name.length > 80 || name.trim() !== name
      || !/^[a-z0-9](?:[a-z0-9._ -]*[a-z0-9_-])?$/i.test(name)
      || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:[. ]|$)/i.test(name)) {
      return { kind: 'invalid', error: 'Enter one project name using letters, numbers, spaces, dots, underscores, or hyphens. Start with a letter or number.' };
    }

    const root = this.config.discoveryRoot;
    const target = path.join(root, name);
    try {
      if (fs.realpathSync(root) !== root) {
        return { kind: 'failed', error: 'The projects folder changed. Set it again in Connections.' };
      }
      if (listProjects(root).length >= PROJECT_LIMIT) {
        return { kind: 'failed', error: 'The projects folder has reached the project limit.' };
      }
      fs.mkdirSync(target);
      const choices = buildProjectChoices(listProjects(root));
      const created = choices.find((choice) => choice.path === target);
      if (!created) return { kind: 'failed', error: 'Could not list the new project.' };
      for (const pending of this.pendingProjectTasks.values()) {
        // Issue a new request ID if a token from the old list now names the new folder.
        if (pending.choices.some((choice) => choice.token === created.token && choice.path !== target)) {
          pending.id = randomBytes(6).toString('hex');
          pending.choices = choices.slice(0, PROJECT_CHOICE_LIMIT);
        }
        if (!pending.choices.some((choice) => choice.path === target)) pending.choices.push(created);
      }
      return { kind: 'created', token: created.token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { kind: 'conflict', error: 'A file or folder with that name already exists.' };
      }
      return { kind: 'failed', error: 'Could not create the project in the projects folder.' };
    }
  }

  /** One short provider-facing note. */
  private tellProvider(
    target: { provider: string; threadId: string },
    text: string,
    sanitize = true,
  ): boolean {
    try {
      const body = sanitize ? sanitizeReply(text, this.harness.mention) : text;
      this.enqueueReply(target.provider, body, target.threadId);
      return true;
    } catch {
      return false;
    }
  }

  /** Send one choice reply and record its panel copy. */
  private tellChoices(item: RelayItem, text: string): boolean {
    try {
      this.enqueueReply(item.provider, text, item.threadId);
    } catch {
      return false;
    }
    try {
      this.announceReply(item.provider, text, item.threadId, item.id);
    } catch { /* the vendor copy still reaches the chat */ }
    return true;
  }

  /** Record a program-authored project reply and its delivery status. */
  private finishChoices(item: RelayItem, text: string, startedAt: number): void {
    const sent = this.tellChoices(item, text);
    this.finishRun(item.id, startedAt, sent, sent ? undefined : 'outbox write failed');
  }

  /** Send one short failure note so a silent run is visible in the chat. */
  private tellFailure(item: RelayItem, text: string): void {
    this.tellProvider(item, text.trim().slice(0, 300));
  }

  /** True when the same introduction already answered in this thread. */
  private seenTrigger(threadId: string, text: string): boolean {
    const key = `${threadId}\nintro\n${text.replace(/\s+/g, ' ').trim()}`;
    const now = Date.now();
    const last = this.recentTriggers.get(key);
    if (last !== undefined && now - last < TRIGGER_DEDUPE_MS) return true;
    this.recentTriggers.delete(key);
    this.recentTriggers.set(key, now);
    while (this.recentTriggers.size > TRIGGER_DEDUPE_LIMIT) {
      const oldest = this.recentTriggers.keys().next().value;
      if (!oldest) break;
      this.recentTriggers.delete(oldest);
    }
    return false;
  }

  /** Drop the recent introduction triggers of one thread. A `/clear` resets the chat context. */
  private clearTriggers(threadId: string): void {
    const prefix = `${threadId}\n`;
    for (const key of [...this.recentTriggers.keys()]) {
      if (key.startsWith(prefix)) this.recentTriggers.delete(key);
    }
  }

  private isClearCommand(text: string): boolean {
    return stripVendorLabel(text).trim().toLowerCase() === '/clear';
  }

  /** The introduction answers a user turn or a leading assistant tag. */
  private isBlibsTrigger(message: HistoryMessage): boolean {
    return isBlibsMention(message.text)
      && (startsWithMention(message.text, BLIBS_MENTION) || message.role === 'user' || isUserTurn(message.text));
  }

  /** Only the provider assistant can send a harness tag. A user tag is ignored. */
  private isHarnessTrigger(message: HistoryMessage): boolean {
    return message.role !== 'user'
      && !isUserTurn(message.text)
      && startsWithMention(message.text, this.harness.mention);
  }

  /** True when the body only asks for the project list. That reply never starts work. */
  private isListBody(body: string): boolean {
    return body.trim() === '';
  }

  private canDispatch(target: { provider: string; threadId: string }): boolean {
    if (this.harnessEnabled()) return true;
    const name = harnessKind(this.config.harnessId).name;
    this.tellProvider(target, `The ${name} harness is disabled. Turn it on in Connections.`);
    return false;
  }

  private queueItem(message: HistoryMessage, body: string): boolean {
    if (!this.canDispatch(message)) return false;
    if (this.queue.length + this.workQueue.length >= RELAY_QUEUE_LIMIT) {
      this.log('skipped', message.id, { reason: 'queue-full' });
      const now = Date.now();
      this.state.lastRun = { state: 'skipped', messageId: message.id, startedAt: now, endedAt: now, error: 'relay queue is full; message dropped' };
      return false;
    }
    this.queue.push({
      id: message.id,
      provider: message.provider,
      threadId: message.threadId,
      body,
    });
    this.log('queued', message.id, { pending: this.queue.length });
    return true;
  }

  // The first batch of a conversation is baseline: a sign-in sync is not work.
  observeBatch(messages: HistoryMessage[]): void {
    if (!this.config.enabled || this.closed) return;
    const groups = new Map<string, HistoryMessage[]>();
    for (const message of messages) {
      if (message.provider.toLowerCase() !== this.config.provider) continue;
      const group = groups.get(message.threadId) ?? [];
      group.push(message);
      groups.set(message.threadId, group);
    }
    let queued = false;
    let changed = false;
    for (const [threadId, rows] of groups) {
      if (!this.knownThreads.has(threadId)) {
        this.rememberThread(threadId);
        for (const row of rows) {
          const eligible = this.accepts(row);
          this.remember(row);
          if (!eligible) continue;
          // An introduction is safe to answer once, even on a baseline batch.
          if (!isIntroMessage(row.text) && this.isBlibsTrigger(row)
            && !this.seenTrigger(threadId, stripVendorLabel(row.text))) {
            this.announceIntro(row);
          }
          // A bare list request is safe to answer on the baseline batch.
          const body = extractMentionBody(row.text, this.harness.mention);
          if (body === null || !this.isHarnessTrigger(row)) continue;
          if (!this.isListBody(body)) {
            this.log('skipped', row.id, { reason: 'conversation-baseline' });
          } else if (this.queueItem(row, body)) {
            queued = true;
          }
        }
        changed = true;
        continue;
      }
      for (const message of rows) {
        if (isIntroMessage(message.text) || isChoicesMessage(message.text)) continue;
        if (this.isClearCommand(message.text)) {
          if (!this.accepts(message)) continue;
          this.remember(message);
          changed = true;
          this.clearTriggers(threadId);
          const lastQueued = this.queue.findLast((item) => item.threadId === threadId);
          if (lastQueued?.body === null) continue;
          if (lastQueued) {
            this.queue.push({ id: message.id, provider: message.provider, threadId, body: null });
            queued = true;
          } else {
            this.pendingProjectTasks.delete(threadId);
          }
          continue;
        }
        if (this.isBlibsTrigger(message)) {
          if (!this.accepts(message)) continue;
          this.remember(message);
          changed = true;
          if (!this.seenTrigger(threadId, stripVendorLabel(message.text))) {
            this.announceIntro(message);
          }
          continue;
        }
        const body = extractMentionBody(message.text, this.harness.mention);
        if (body === null) continue;
        if (!this.isHarnessTrigger(message)) {
          this.log('skipped', message.id, { reason: 'not-an-assistant-trigger' });
          continue;
        }
        if (!this.accepts(message)) {
          const reason = this.state.processed.includes(message.id) ? 'already-processed'
            : message.ts < this.state.watermark ? 'before-watermark' : 'ineligible-message';
          this.log('skipped', message.id, { reason });
          continue;
        }
        // The queue only carries the text behind the mention. The relay reads
        // it when the queue drains, so a choice uses the current project list.
        this.remember(message);
        changed = true;
        // Preserve the full name so invalid characters are rejected.
        const request = /^\/new-project(?:\s|$)/i.test(body)
          ? stripVendorLabel(message.text).slice(this.harness.mention.length).trim()
          : body;
        if (this.queueItem(message, request)) queued = true;
      }
    }
    if (changed) this.save();
    if (queued) this.drain();
  }

  private drain(): void {
    while (this.queue.length && !this.closed) {
      const item = this.queue.shift()!;
      try {
        this.runOne(item);
      } catch {
        this.failDispatch(item);
      }
    }
    this.dispatchWork();
  }

  private failDispatch(item: RelayItem): void {
    this.log('relay-error', item.id);
    this.tellFailure(item, 'blibs could not process this harness request.');
    this.finishRun(item.id, Date.now(), false, 'unexpected relay error');
  }

  private dispatchWork(): void {
    while (!this.closed) {
      const index = this.workQueue.findIndex(({ projectPath }) => !this.active.has(projectPath));
      if (index === -1) return;
      const [queued] = this.workQueue.splice(index, 1);
      const { item, projectPath } = queued;
      const work = { item, startedAt: Date.now() };
      this.active.set(projectPath, work);
      void this.startWork(queued, work).catch(() => {
        if (!this.closed) this.failDispatch(item);
      }).finally(() => {
        this.active.delete(projectPath);
        this.dispatchWork();
      });
    }
  }

  private async startWork(queued: RelayWork, work: ActiveWork): Promise<void> {
    const { item, task, projectPath, model } = queued;
    if (!this.canDispatch(item) || !this.projectAvailable(work, projectPath)) return;
    if (model && this.harness.listModels) {
      const catalog = new AbortController();
      work.catalog = catalog;
      const models = await this.harness.listModels(projectPath, catalog.signal);
      work.catalog = undefined;
      if (this.closed || !this.canDispatch(item) || !this.projectAvailable(work, projectPath)) return;
      if (models && !models.includes(model.split('#', 1)[0])) {
        return this.finishChoices(item, formatModelChoices(model, models), work.startedAt);
      }
    }
    const token = buildProjectChoices(listProjects(this.config.discoveryRoot))
      .find((choice) => choice.path === projectPath)?.token;
    if (!token) throw new Error('Could not find project ID.');
    const session = this.resolveSession(queued, token);
    if (session) {
      await this.runWork(work, task, {
        ...session, cwd: projectPath, model: model ?? this.state.modelDefaults[this.config.harnessId],
      });
    }
  }

  private projectAvailable({ item, startedAt }: ActiveWork, projectPath: string): boolean {
    if (path.dirname(projectPath) === this.config.discoveryRoot
      && fs.lstatSync(projectPath, { throwIfNoEntry: false })?.isDirectory()) return true;
    const error = 'The selected project is no longer available. Send a new task.';
    this.tellFailure(item, error);
    this.finishRun(item.id, startedAt, false, error);
    return false;
  }

  /** Resolve a task or a selection against the current project list. */
  private runOne(item: RelayItem): void {
    if (item.body === null) {
      this.pendingProjectTasks.delete(item.threadId);
      return;
    }
    if (this.closed || !this.canDispatch(item)) return;
    const pending = this.pendingProjectTasks.get(item.threadId);
    if (pending?.body === item.body) return;
    const startedAt = Date.now();
    const body = item.body.trim();
    const [command, first, second, extra] = body.split(/\s+/, 4);
    const action = command.toLowerCase();
    if (action === '/new-project') {
      const result = this.createProject(body.slice(command.length).trim());
      const mention = this.harness.mention;
      const note = result.kind === 'created'
        ? `Project created. Project ID: $${result.token}.` + (pending
          ? ` Reply with ${projectSelectionFormat(mention, pending.id, `$${result.token}`)} to see its sessions.`
          : ` Send ${mention} /new $${result.token} <name> <task> to start a session.`)
        : result.error;
      return this.finishChoices(item, `${CHOICES_HEADER}\n\n${note}`, startedAt);
    }
    const allChoices = buildProjectChoices(listProjects(this.config.discoveryRoot));
    const choices = allChoices.slice(0, PROJECT_CHOICE_LIMIT);
    const options = { ...this.choiceOptions(), total: allChoices.length };
    if (['/sessions', '/new', '/resume'].includes(action)) {
      const project = first;
      const value = second;
      const choice = allChoices.find(({ token }) => `$${token}` === project?.toLowerCase());
      let task = body.match(/^\S+\s+\S+\s+\S+\s+([\s\S]+)$/)?.[1];
      if (!choice) {
        return this.finishChoices(item, formatProjectList(choices, { ...options, note: 'Use an available project ID.' }), startedAt);
      }
      if (action === '/sessions' && !value) return this.showSessions(item, choice, startedAt);
      if (extra && task && (action === '/resume' || (action === '/new' && SESSION_NAME.test(value)))) {
        let model: string | undefined;
        if (/^--model(?:\s|=|$)/.test(task)) {
          const override = /^--model\s+(\S+)\s+([\s\S]+)$/.exec(task);
          model = parseModel(override?.[1]);
          if (!override || !model) {
            return this.finishChoices(item, `${CHOICES_HEADER}\n\nUse --model <model-id> followed by the full task.`, startedAt);
          }
          task = override[2];
        }
        const session: SessionRequest = action === '/resume' ? { kind: 'resume', selector: value } : { kind: 'new', name: value };
        this.pendingProjectTasks.delete(item.threadId);
        this.workQueue.push({ item, task, projectPath: choice.path, session, model });
        return;
      }
      return this.finishChoices(item, [CHOICES_HEADER, '', ...sessionCommands(this.harness.mention)].join('\n'), startedAt);
    }
    if (action === '/select') {
      const requestId = first;
      const token = second;
      if (!pending || requestId !== pending.id) {
        return this.finishChoices(item, formatProjectList(choices, {
          ...options,
          note: 'This project choice is no longer active. Send a new task or use the request ID from the latest choice reply.',
        }), startedAt);
      }
      const selected = !extra && pending.choices.find((choice) => `$${choice.token}` === token?.toLowerCase());
      const current = selected && allChoices.find((choice) => choice.path === selected.path);
      if (current) {
        this.pendingProjectTasks.delete(item.threadId);
        return this.showSessions(item, current, startedAt);
      }
      const available = pending.choices.filter((choice) => allChoices.some((current) => current.path === choice.path));
      return this.finishChoices(item, formatProjectList(available.slice(0, PROJECT_CHOICE_LIMIT), {
        ...this.choiceOptions(),
        total: available.length,
        requestId: pending.id,
        note: 'Choose an available project ID from this request, or send a new task.',
      }), startedAt);
    }

    const match = matchProject(item.body, allChoices);
    this.log('project-match', item.id, { result: match.kind, projectCount: allChoices.length });

    if (match.kind === 'project') {
      this.pendingProjectTasks.delete(item.threadId);
      return this.showSessions(item, match.choice, startedAt);
    }

    const task = match.kind === 'unknown' ? taskAfterUnknownProject(item.body) : item.body.trim();
    const note = match.kind === 'unknown' ? unknownProjectNote(match.name, options)
      : match.kind === 'ambiguous' ? 'The task names more than one project.' : undefined;
    const id = task ? randomBytes(6).toString('hex') : undefined;
    const sent = this.tellChoices(item, formatProjectList(choices, { ...options, note, requestId: id }));
    if (sent && task) {
      this.pendingProjectTasks.delete(item.threadId);
      if (id && this.knownThreads.has(item.threadId)) {
        this.pendingProjectTasks.set(item.threadId, { id, body: item.body, choices });
      }
    }
    this.finishRun(item.id, startedAt, sent, sent ? undefined : 'outbox write failed');
  }

  private async runWork(work: ActiveWork, task: string, options: HarnessStartOptions): Promise<void> {
    const { item, startedAt } = work;
    this.state.lastRun = { state: 'running', messageId: item.id, startedAt };
    this.save();

    this.log('harness-start', item.id, {
      harness: this.config.harnessId,
      model: options.model ?? 'default',
    });
    const run = this.harness.start(buildPrompt(task), options);
    work.run = run;
    let ok = false;
    let error: string | undefined;
    try {
      const result = await run.promise;
      if (this.closed) return;
      error = result.error;
      this.log('harness-result', item.id, {
        outcome: result.ok ? 'ok' : 'failed',
        exitCode: result.code ?? 'unavailable',
        ...result.diagnostics,
      });
      if (result.ok) {
        const reply = harnessMessage(result.reply, harnessKind(this.config.harnessId).name);
        ok = reply ? this.tellProvider(item, reply) : false;
        if (!ok) error = 'outbox write failed';
      }
    } catch (e) {
      error = `harness failed: ${(e as Error).message}`;
    }
    if (this.closed) return;
    if (!ok) {
      this.tellFailure(
        item,
        `The ${harnessKind(this.config.harnessId).name} harness failed: ${error ?? 'unknown error'}`,
      );
    }
    this.finishRun(item.id, startedAt, ok, ok ? undefined : (error ?? 'harness failed'));
  }

  private finishRun(messageId: string, startedAt: number, ok: boolean, error?: string): void {
    this.log(ok ? 'reply-queued' : 'run-failed', messageId, {
      elapsedMs: Date.now() - startedAt,
    });
    this.state.runs += 1;
    this.state.lastRun = ok
      ? { state: 'ok', messageId, startedAt, endedAt: Date.now() }
      : { state: 'error', messageId, startedAt, endedAt: Date.now(), error: error ?? 'relay failed' };
    this.save();
  }

  status(): RelayStatus {
    const model = this.state.modelDefaults[this.config.harnessId];
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      harness: {
        id: this.config.harnessId,
        command: this.config.command,
        cwd: this.config.cwd,
        ...(model ? { model } : {}),
      },
      modelDefaults: HARNESS_KINDS.map(({ id, name }) => ({ id, name, model: this.state.modelDefaults[id] })),
      harnesses: this.harnesses(),
      discoveryRoot: this.state.discoveryRoot,
      projects: buildProjectChoices(listProjects(this.config.discoveryRoot)).map(({ path: projectPath, token }) => ({
        name: path.basename(projectPath),
        token,
      })),
      pending: this.queue.length + this.workQueue.length + this.active.size,
      running: this.active.size > 0,
      processed: this.state.processed.length,
      watermark: this.state.watermark,
      sessions: Object.keys(this.state.sessions).length + this.state.namedSessions.length,
      lastRun: this.state.lastRun,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.workQueue.length = 0;
    for (const { item, startedAt, catalog, run } of this.active.values()) {
      catalog?.abort();
      if (!run) continue;
      run.kill();
      this.log('harness-interrupted', item.id, { elapsedMs: Date.now() - startedAt });
      this.state.lastRun = { state: 'running', messageId: item.id, startedAt };
    }
    this.active.clear();
    if (this.interruptLastRun('relay stopped before the harness finished')) this.save();
  }
}
