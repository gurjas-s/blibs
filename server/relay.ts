import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryMessage } from './history.js';
import { DEFAULT_DISCOVERY_ROOT, DEFAULT_RELAY_MODEL } from './relay-defaults.js';
import type { Harness, HarnessResult, HarnessRun } from './harness/types.js';
import { extractMentionBody, isUserTurn, sanitizeReply, startsWithMention } from './harness/mention.js';
import { stripVendorLabel } from '../shared/vendor-label.js';
import { BLIBS_MENTION, isBlibsMention, isIntroMessage, introMessage } from './harness/intro.js';
import type { HarnessChoice } from './harness/intro.js';
import { harnessMessage } from './harness/message.js';
import {
  buildProjectChoices,
  PROJECT_CHOICE_LIMIT,
  formatMissingTask,
  formatProjectList,
  formatUnknownProject,
  isChoicesMessage,
} from './harness/project-reply.js';
import type { ReplyOptions } from './harness/project-reply.js';
import { HARNESS_KINDS, harnessKind } from './harness/registry.js';
import {
  RELAY_PROCESSED_LIMIT,
  RELAY_SESSION_LIMIT,
  RELAY_STATE_VERSION,
  RELAY_THREAD_LIMIT,
  parseHarnesses,
  parseModel,
  parseRelayRun,
  parseSessions,
  parseStringArray,
  readRelayStateFile,
} from './relay-state.js';
import type { RelayRunState, RelayState } from './relay-state.js';
import {
  canonicalDir,
  listProjects,
  matchProject,
  projectsRoot,
  sessionKey,
  sessionKeyPrefix,
  taskAfterProject,
} from './harness/projects.js';

export const RELAY_QUEUE_LIMIT = 20;
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000;
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
  timeoutMs: number;
  /** Default harness model in provider/model form. Empty means the harness default. */
  model?: string;
  /** Directory whose immediate subfolders are the projects. */
  discoveryRoot: string;
}

export interface RelayStatus {
  enabled: boolean;
  provider: string;
  harness: { id: string; command: string; cwd: string; timeoutMs: number; model?: string };
  /** Harness rows the panel reported for the introduction reply. */
  harnesses: HarnessChoice[];
  discoveryRoot: string;
  pending: number;
  running: boolean;
  processed: number;
  watermark: number;
  sessions: number;
  lastRun: RelayRunState | null;
}

interface RelayItem {
  id: string;
  provider: string;
  threadId: string;
  /** Text behind the harness mention. Empty means the project list. */
  body: string;
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
    timeoutMs: DEFAULT_RELAY_TIMEOUT_MS,
    ...overrides,
    model: overrides.model ?? DEFAULT_RELAY_MODEL,
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

export function newSessionId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 24; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `ses_${suffix}`;
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
  /** Trigger text per thread. A re-scraped message gets a new message id. */
  private readonly recentTriggers = new Map<string, number>();
  private active: HarnessRun | null = null;
  private closed = false;
  private draining = false;

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
          discoveryRoot: canonicalDir(options.config.discoveryRoot),
          model: options.config.model,
          harnesses: [],
          runs: 0,
          lastRun: null,
        };
    if (loaded) this.config = { ...this.config, discoveryRoot: loaded.discoveryRoot };
    if (loaded?.model) this.config = { ...this.config, model: loaded.model };
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
    return {
      version: RELAY_STATE_VERSION,
      watermark: typeof raw.watermark === 'number' && Number.isFinite(raw.watermark) ? raw.watermark : Date.now(),
      processed: parseStringArray(raw.processed, RELAY_PROCESSED_LIMIT),
      threads: parseStringArray(raw.threads, RELAY_THREAD_LIMIT),
      sessions: parseSessions(raw.sessions),
      discoveryRoot: canonicalDir(projectsRoot(root)),
      model: parseModel(raw.model),
      harnesses: parseHarnesses(raw.harnesses),
      runs: typeof raw.runs === 'number' && raw.runs >= 0 ? raw.runs : 0,
      lastRun: parseRelayRun(raw.lastRun),
    };
  }

  private save(): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const staging = `${this.stateFile}.tmp`;
      fs.writeFileSync(staging, JSON.stringify(this.state, null, 2));
      fs.renameSync(staging, this.stateFile);
    } catch { /* keep the in-memory state; the next write retries */ }
  }

  /** Turn a running last run into an error record. True when the record changed. */
  private interruptLastRun(error: string): boolean {
    const last = this.state.lastRun;
    if (last?.state !== 'running') return false;
    this.state.lastRun = { state: 'error', messageId: last.messageId, startedAt: last.startedAt, endedAt: Date.now(), error };
    return true;
  }

  private log(event: string, messageId: string, details: Record<string, string | number> = {}): void {
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

  private storeSession(threadId: string, projectPath: string, sessionId: string): string {
    this.state.sessions[sessionKey(threadId, projectPath)] = sessionId;
    const keys = Object.keys(this.state.sessions);
    if (keys.length > RELAY_SESSION_LIMIT) delete this.state.sessions[keys[0]];
    return sessionId;
  }

  /** One session per project per thread. The first run creates it. */
  private sessionFor(threadId: string, projectPath: string): string {
    return this.storedSession(threadId, projectPath) ?? this.storeSession(threadId, projectPath, newSessionId());
  }

  private choiceOptions(): ReplyOptions {
    return {
      mention: this.harness.mention,
      root: this.config.discoveryRoot,
    };
  }

  /**
   * Harness rows for the introduction reply. A report from the panel wins,
   * because the panel owns the per-assistant toggles. Without a report, every
   * harness that this build can drive counts as enabled.
   */
  harnesses(): HarnessChoice[] {
    if (this.state.harnesses.length) {
      return this.state.harnesses.map((choice) => ({ ...choice }));
    }
    return HARNESS_KINDS.map((kind) => ({ id: kind.id, name: kind.name, enabled: true }));
  }

  updateHarnesses(reported: HarnessChoice[]): RelayStatus {
    this.state.harnesses = reported.map((choice) => ({ ...choice }));
    this.save();
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
  updateProjects(discoveryRoot?: string, model?: string | null): RelayStatus {
    if (discoveryRoot !== undefined) {
      const resolved = canonicalDir(projectsRoot(discoveryRoot));
      try { fs.mkdirSync(resolved, { recursive: true }); } catch { /* the next run reports a missing directory */ }
      this.state.discoveryRoot = resolved;
      this.config = { ...this.config, discoveryRoot: resolved };
    }
    if (model !== undefined) {
      const nextModel = model ?? DEFAULT_RELAY_MODEL;
      this.state.model = nextModel;
      this.config = { ...this.config, model: nextModel };
    }
    this.save();
    return this.status();
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

  private queueItem(message: HistoryMessage, body: string): boolean {
    if (this.queue.length >= RELAY_QUEUE_LIMIT) {
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
        if (this.queueItem(message, body)) queued = true;
      }
    }
    if (changed) this.save();
    if (queued) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.closed) {
        const item = this.queue.shift();
        if (!item) break;
        try {
          await this.runOne(item);
        } catch {
          this.log('relay-error', item.id);
          this.tellFailure(item, 'blibs could not process this harness request.');
          this.finishRun(item.id, Date.now(), false, 'unexpected relay error');
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Resolve one mention without guessing. An explicit path or a project folder
   * name runs the task. A named project that does not exist gets the
   * create-project reply. Anything else gets the project list, and the
   * provider picks a project and sends the task again.
   */
  private async runOne(item: RelayItem): Promise<void> {
    if (this.closed) return;
    const startedAt = Date.now();
    this.state.lastRun = { state: 'running', messageId: item.id, startedAt };
    this.save();

    const projects = listProjects(this.config.discoveryRoot);
    const allChoices = buildProjectChoices(projects);
    const choices = allChoices.slice(0, PROJECT_CHOICE_LIMIT);
    const options = this.choiceOptions();
    const match = matchProject(item.body, allChoices);
    this.log('project-match', item.id, { result: match.kind, projectCount: projects.length });

    if (match.kind === 'project') {
      const task = taskAfterProject(item.body, match);
      if (!task) {
        return this.finishChoices(item, formatMissingTask(match.choice.token, options), startedAt);
      }
      return this.runWork(item, task, match.choice.path, startedAt);
    }
    if (match.kind === 'unknown') {
      return this.finishChoices(item, formatUnknownProject(match.name, options), startedAt);
    }
    const text = formatProjectList(choices, {
      ...options,
      ...(projects.length > choices.length
        ? { note: `Showing the first ${choices.length} of ${projects.length} projects.` }
        : {}),
    });
    return this.finishChoices(item, text, startedAt);
  }

  /** Await one run and keep it visible as the active run while it settles. */
  private async awaitRun(run: HarnessRun): Promise<HarnessResult> {
    this.active = run;
    try {
      return await run.promise;
    } finally {
      this.active = null;
    }
  }

  private async runWork(
    item: RelayItem,
    task: string,
    projectPath: string,
    startedAt: number,
  ): Promise<void> {
    this.log('harness-start', item.id, { harness: this.config.harnessId });
    const run = this.harness.start(buildPrompt(task), {
      sessionId: this.sessionFor(item.threadId, projectPath),
      cwd: projectPath,
      model: this.config.model,
    });
    let ok = false;
    let error: string | undefined;
    try {
      const result = await this.awaitRun(run);
      if (this.closed) return;
      error = result.error;
      this.log('harness-result', item.id, {
        outcome: result.ok ? 'ok' : result.error?.startsWith('harness timed out') ? 'timeout' : 'failed',
        exitCode: result.code ?? 'unavailable',
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
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      harness: {
        id: this.config.harnessId,
        command: this.config.command,
        cwd: this.config.cwd,
        timeoutMs: this.config.timeoutMs,
        ...(this.config.model ? { model: this.config.model } : {}),
      },
      harnesses: this.harnesses(),
      discoveryRoot: this.state.discoveryRoot,
      pending: this.queue.length + (this.active ? 1 : 0),
      running: this.active !== null,
      processed: this.state.processed.length,
      watermark: this.state.watermark,
      sessions: Object.keys(this.state.sessions).length,
      lastRun: this.state.lastRun,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.active?.kill();
    this.active = null;
    if (this.interruptLastRun('relay stopped before the harness finished')) this.save();
  }
}
