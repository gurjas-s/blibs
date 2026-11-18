import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryMessage } from './history.js';
import type { Harness, HarnessRun } from './harness/types.js';
import { extractMentionTask, sanitizeReply } from './harness/mention.js';
import { sessionKey, threadProjects } from './harness/router.js';

export const RELAY_QUEUE_LIMIT = 20;
export const RELAY_PROCESSED_LIMIT = 500;
export const RELAY_THREAD_LIMIT = 500;
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000;
export const RELAY_PROVIDER = 'muse';
export const DEFAULT_HARNESS_COMMAND = 'opencode run';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_HOSTS: Record<string, string> = { muse: 'muse.ai', dots: 'chatgpt.com', grok: 'grok.com' };
const CHECKOUT_ROOT_DEPTH = 8;
const ERROR_TEXT_LIMIT = 300;

export interface RelayConfig {
  enabled: boolean;
  provider: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Default harness model in provider/model form. Empty means the harness default. */
  model?: string;
}

export interface RelayRunState {
  state: 'running' | 'ok' | 'error' | 'skipped';
  messageId: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface RelayStatus {
  enabled: boolean;
  provider: string;
  harness: { command: string; cwd: string; timeoutMs: number; model?: string };
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
  task: string;
  sessionId: string;
  projectPath: string;
}

interface RelayState {
  version: 2;
  watermark: number;
  processed: string[];
  threads: string[];
  /** Coding sessions keyed by thread id and project path. */
  sessions: Record<string, string>;
  runs: number;
  lastRun: RelayRunState | null;
}

export interface RelayServiceOptions {
  config: RelayConfig;
  harness: Harness;
  stateDir: string;
  enqueue: (provider: string, text: string, threadId?: string) => void;
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

export const DEFAULT_DISCOVERY_ROOT = path.join(os.homedir(), 'Projects');

export function buildRelayConfig(dataDir: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  const config: RelayConfig = {
    enabled: true,
    provider: RELAY_PROVIDER,
    command: DEFAULT_HARNESS_COMMAND,
    cwd: path.join(dataDir, 'harness'),
    timeoutMs: DEFAULT_RELAY_TIMEOUT_MS,
    model: undefined,
    ...overrides,
  };
  return { ...config, cwd: safeHarnessCwd(path.resolve(config.cwd), dataDir) };
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
export function isProviderThread(provider: string, threadId: string): boolean {
  const host = PROVIDER_HOSTS[provider];
  if (!host) return true;
  try {
    const url = new URL(threadId);
    return url.protocol === 'https:' && url.hostname === host;
  } catch {
    return false;
  }
}

export function isConversationThread(provider: string, threadId: string): boolean {
  if (!isProviderThread(provider, threadId)) return false;
  if (!PROVIDER_HOSTS[provider]) return true;
  try {
    const url = new URL(threadId);
    return url.pathname !== '/' && url.pathname !== '';
  } catch {
    return false;
  }
}

export class RelayService {
  private config: RelayConfig;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly harness: Harness;
  private readonly enqueueReply: (provider: string, text: string, threadId?: string) => void;
  private readonly threadHasUser: (provider: string, threadId: string) => boolean;
  private readonly state: RelayState;
  private readonly knownThreads: Set<string>;
  private readonly queue: RelayItem[] = [];
  private active: HarnessRun | null = null;
  private closed = false;
  private draining = false;

  constructor(options: RelayServiceOptions) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.stateFile = path.join(options.stateDir, 'relay-state.json');
    this.harness = options.harness;
    this.enqueueReply = options.enqueue;
    this.threadHasUser = options.threadHasUser ?? (() => false);
    if (this.config.enabled) fs.mkdirSync(this.config.cwd, { recursive: true });

    const loaded = this.loadState();
    this.state = loaded
      ? loaded
      : {
          version: 2,
          watermark: Date.now(),
          processed: [],
          threads: [],
          sessions: {},
          runs: 0,
          lastRun: null,
        };
    this.knownThreads = new Set([...(options.knownThreads ?? []), ...this.state.threads].slice(-RELAY_THREAD_LIMIT));
    this.state.threads = [...this.knownThreads];
    if (this.state.lastRun?.state === 'running') {
      this.state.lastRun = {
        state: 'error',
        messageId: this.state.lastRun.messageId,
        startedAt: this.state.lastRun.startedAt,
        endedAt: Date.now(),
        error: 'interrupted by restart',
      };
    }
    // No watermark is written on a disabled start, so stored rows stay backlog.
    if (!loaded && this.config.enabled) this.save();
  }

  private loadState(): RelayState | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<RelayState>;
      if (raw.version !== 2) return null;
      const watermark = typeof raw.watermark === 'number' && Number.isFinite(raw.watermark) ? raw.watermark : Date.now();
      const processed = Array.isArray(raw.processed)
        ? raw.processed.filter((id): id is string => typeof id === 'string').slice(-RELAY_PROCESSED_LIMIT)
        : [];
      const threads = Array.isArray(raw.threads)
        ? raw.threads.filter((id): id is string => typeof id === 'string').slice(-RELAY_THREAD_LIMIT)
        : [];
      const runs = typeof raw.runs === 'number' && raw.runs >= 0 ? raw.runs : 0;
      const sessions: Record<string, string> = {};
      if (raw.sessions && typeof raw.sessions === 'object') {
        for (const [key, value] of Object.entries(raw.sessions as Record<string, unknown>)) {
          if (typeof value === 'string' && value) sessions[key.slice(0, 1000)] = value.slice(0, 100);
        }
      }
      return { version: 2, watermark, processed, threads, sessions, runs, lastRun: this.readLastRun(raw.lastRun) };
    } catch {
      return null;
    }
  }

  private readLastRun(value: unknown): RelayRunState | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<RelayRunState>;
    if (raw.state !== 'running' && raw.state !== 'ok' && raw.state !== 'error' && raw.state !== 'skipped') return null;
    if (typeof raw.messageId !== 'string' || typeof raw.startedAt !== 'number') return null;
    return {
      state: raw.state,
      messageId: raw.messageId,
      startedAt: raw.startedAt,
      endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : undefined,
      error: typeof raw.error === 'string' ? raw.error.slice(0, ERROR_TEXT_LIMIT) : undefined,
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
    if (extractMentionTask(message.text) === null) return false;
    return message.ts > this.state.watermark;
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
      const prefix = `${oldest}\n`;
      for (const key of Object.keys(this.state.sessions)) {
        if (key.startsWith(prefix)) delete this.state.sessions[key];
      }
    }
    this.state.threads = [...this.knownThreads].slice(-RELAY_THREAD_LIMIT);
  }

  private sessionFor(threadId: string, projectPath: string): string {
    const key = sessionKey(threadId, projectPath);
    const existing = this.state.sessions[key];
    if (existing) return existing;
    const created = newSessionId();
    this.state.sessions[key] = created;
    const keys = Object.keys(this.state.sessions);
    if (keys.length > RELAY_THREAD_LIMIT) delete this.state.sessions[keys[0]];
    return created;
  }

  /** Project paths with sessions in one Muse thread, most recent last. */
  projectsFor(threadId: string): string[] {
    return threadProjects(this.state.sessions, threadId);
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
        for (const row of rows) this.remember(row);
        changed = true;
        continue;
      }
      const seenTasks = new Set<string>();
      for (const message of rows) {
        if (!this.accepts(message)) continue;
        const task = extractMentionTask(message.text);
        if (task === null) continue;
        const taskKey = `${threadId}\n${task}`;
        if (seenTasks.has(taskKey)) continue;
        seenTasks.add(taskKey);
        // The project router lands in a later change. Every task uses the
        // configured harness directory until then.
        const projectPath = this.config.cwd;
        this.remember(message);
        changed = true;
        if (this.queue.length >= RELAY_QUEUE_LIMIT) {
          const now = Date.now();
          this.state.lastRun = { state: 'skipped', messageId: message.id, startedAt: now, endedAt: now, error: 'relay queue is full; message dropped' };
          continue;
        }
        this.queue.push({
          id: message.id,
          provider: message.provider,
          threadId: message.threadId,
          task,
          sessionId: this.sessionFor(threadId, projectPath),
          projectPath,
        });
        queued = true;
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
        await this.runOne(item);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(item: RelayItem): Promise<void> {
    if (this.closed) return;
    const startedAt = Date.now();
    this.state.lastRun = { state: 'running', messageId: item.id, startedAt };
    this.save();
    const run = this.harness.start(buildPrompt(item.task), { sessionId: item.sessionId, cwd: item.projectPath, model: this.config.model });
    this.active = run;
    let ok = false;
    let error: string | undefined;
    try {
      const result = await run.promise;
      error = result.error;
      if (result.ok) {
        try {
          this.enqueueReply(item.provider, sanitizeReply(result.reply), item.threadId);
          ok = true;
        } catch {
          error = 'outbox write failed';
        }
      }
    } catch (e) {
      error = `harness failed: ${(e as Error).message}`;
    } finally {
      this.active = null;
    }
    if (this.closed) return;
    const endedAt = Date.now();
    this.state.runs += 1;
    this.state.lastRun = ok
      ? { state: 'ok', messageId: item.id, startedAt, endedAt }
      : { state: 'error', messageId: item.id, startedAt, endedAt, error: error ?? 'harness failed' };
    this.save();
  }

  status(): RelayStatus {
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      harness: {
        command: this.config.command,
        cwd: this.config.cwd,
        timeoutMs: this.config.timeoutMs,
        ...(this.config.model ? { model: this.config.model } : {}),
      },
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
    if (this.state.lastRun?.state === 'running') {
      this.state.lastRun = {
        state: 'error',
        messageId: this.state.lastRun.messageId,
        startedAt: this.state.lastRun.startedAt,
        endedAt: Date.now(),
        error: 'relay stopped before the harness finished',
      };
      this.save();
    }
  }
}
