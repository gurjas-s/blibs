// Relay service: one inbound assistant message in, one harness run, one reply
// queued in the existing outbox.
//
// Scope:
// - only new messages from the configured provider with role `agent`
// - only messages newer than the durable high-water mark
// - one run at a time, bounded queue, bounded prompt and reply
// - state in the data directory, so a restart does not replay history
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryMessage } from './history.js';
import { RELAY_REPLY_LIMIT, startHarness } from './harness.js';
import type { HarnessResult } from './harness.js';

export const RELAY_QUEUE_LIMIT = 20;
export const RELAY_PROCESSED_LIMIT = 500;
export const RELAY_THREAD_LIMIT = 500;
export const RELAY_PROMPT_LIMIT = 2000;
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SECRET_KEYS = ['EMAIL_MUSE', 'PASSWORD_MUSE', 'PROTON_URL'] as const;
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const PROVIDER_HOSTS: Record<string, string> = { muse: 'muse.ai', dots: 'chatgpt.com', grok: 'grok.com' };
const PROMPT_HEADER = "A message from the user's personal assistant follows. Complete the request and reply with the final answer only. Keep the reply under 1500 characters.";

export interface RelayConfig {
  enabled: boolean;
  provider: string;
  command: string;
  cwd: string;
  timeoutMs: number;
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
  harness: { command: string; cwd: string; timeoutMs: number };
  pending: number;
  running: boolean;
  processed: number;
  watermark: number;
  lastRun: RelayRunState | null;
}

interface RelayItem {
  id: string;
  provider: string;
  task: string;
}

interface RelayState {
  version: 1;
  watermark: number;
  processed: string[];
  /** Conversations that already had a baseline observation. */
  threads: string[];
  runs: number;
  lastRun: RelayRunState | null;
}

export interface RelayServiceOptions {
  config: RelayConfig;
  /** Directory for `relay-state.json` and the default sandbox. */
  stateDir: string;
  /** Writes the reply to the existing outbox. */
  enqueue: (provider: string, text: string) => void;
  /** Threads that the history store already knew at startup. */
  knownThreads?: string[];
  /** True when the thread already has a user message. */
  threadHasUser?: (provider: string, threadId: string) => boolean;
}

/** Replace a credential value if it appears in status text. */
export function redactSecrets(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = value;
  for (const key of SECRET_KEYS) {
    const secret = env[key];
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Find the blibs checkout that contains `start`. */
export function findCheckoutRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 8; depth++) {
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

/** Build the relay configuration from the environment with safe defaults. */
export function relayConfigFromEnv(env: NodeJS.ProcessEnv = process.env, dataDir = ''): RelayConfig {
  const provider = (env.BLIBS_RELAY_PROVIDER || 'muse').trim().toLowerCase().slice(0, 40) || 'muse';
  const command = (env.BLIBS_HARNESS_CMD || 'opencode run').trim();
  const fallbackCwd = path.join(dataDir || process.cwd(), 'harness');
  const cwd = path.resolve((env.BLIBS_HARNESS_CWD || '').trim() || fallbackCwd);
  const requestedTimeout = Number(env.BLIBS_RELAY_TIMEOUT_MS || DEFAULT_RELAY_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(600_000, Math.max(1000, Math.floor(requestedTimeout)))
    : DEFAULT_RELAY_TIMEOUT_MS;
  return {
    enabled: TRUTHY.has((env.BLIBS_RELAY || '').trim().toLowerCase()),
    provider,
    command,
    cwd,
    timeoutMs,
  };
}

/** A Muse user turn is scraped with the vendor's "You:" label and agent role. */
export function isUserEcho(text: string): boolean {
  return text.trimStart().startsWith('You:');
}

/** A rendered time label is not a message. */
export function isTimeLabel(text: string): boolean {
  return /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(text.trim());
}

/** Build the bounded prompt that the harness receives. */
export function buildPrompt(task: string): string {
  return `${PROMPT_HEADER}\n\n${task.trim().slice(0, RELAY_PROMPT_LIMIT)}`;
}

/**
 * A vendor landing page is not a conversation. The view scrapes marketing
 * articles on `https://muse.ai/`, so a thread must be a provider page below
 * the root. Providers without a known host keep their rows.
 */
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

/** True for a provider URL below its root, such as `/chat/abc`. */
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
  private readonly config: RelayConfig;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly enqueueReply: (provider: string, text: string) => void;
  private readonly threadHasUser: (provider: string, threadId: string) => boolean;
  private readonly cwd: string;
  private readonly state: RelayState;
  private readonly knownThreads: Set<string>;
  private readonly queue: RelayItem[] = [];
  private active: { kill(): void } | null = null;
  private closed = false;
  private draining = false;

  constructor(options: RelayServiceOptions) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.stateFile = path.join(options.stateDir, 'relay-state.json');
    this.enqueueReply = options.enqueue;
    this.threadHasUser = options.threadHasUser ?? (() => false);

    // Never run the harness in the blibs checkout, even with a bad override.
    const dataFallback = path.join(options.stateDir, 'harness');
    const checkout = findCheckoutRoot(MODULE_DIR);
    const fallback = checkout && inside(dataFallback, checkout) ? path.join(os.tmpdir(), 'blibs-harness') : dataFallback;
    const requested = path.resolve(options.config.cwd || fallback);
    this.cwd = checkout && inside(requested, checkout) ? fallback : requested;
    if (options.config.enabled) fs.mkdirSync(this.cwd, { recursive: true });

    const loaded = this.loadState();
    this.state = loaded
      ? loaded
      : { version: 1, watermark: Date.now(), processed: [], threads: [], runs: 0, lastRun: null };
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
    // A disabled relay must not write an early watermark. The first enabled
    // start then treats everything already stored as backlog.
    if (!loaded && this.config.enabled) this.save();
  }

  private loadState(): RelayState | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<RelayState>;
      if (raw.version !== 1) return null;
      const watermark = typeof raw.watermark === 'number' && Number.isFinite(raw.watermark) ? raw.watermark : Date.now();
      const processed = Array.isArray(raw.processed)
        ? raw.processed.filter((id): id is string => typeof id === 'string').slice(-RELAY_PROCESSED_LIMIT)
        : [];
      const threads = Array.isArray(raw.threads)
        ? raw.threads.filter((id): id is string => typeof id === 'string').slice(-RELAY_THREAD_LIMIT)
        : [];
      const runs = typeof raw.runs === 'number' && raw.runs >= 0 ? raw.runs : 0;
      return { version: 1, watermark, processed, threads, runs, lastRun: this.readLastRun(raw.lastRun) };
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
      error: typeof raw.error === 'string' ? raw.error.slice(0, 300) : undefined,
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

  /** True when a new row in a known thread can start a run. */
  private accepts(message: HistoryMessage): boolean {
    if (!this.config.enabled || this.closed) return false;
    if (message.role !== 'agent') return false;
    if (message.provider.toLowerCase() !== this.config.provider) return false;
    // Muse renders the user turn with a "You:" label but reports role agent.
    if (isUserEcho(message.text) || isTimeLabel(message.text)) return false;
    if (!isProviderThread(this.config.provider, message.threadId)) return false;
    // A root path is the landing page until the conversation has a user turn.
    // The Muse chat stays at `https://muse.ai/`.
    if (!isConversationThread(this.config.provider, message.threadId)
      && !this.threadHasUser(this.config.provider, message.threadId)) return false;
    if (this.state.processed.includes(message.id)) return false;
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
    if (threads.length > RELAY_THREAD_LIMIT) this.knownThreads.delete(threads[0]);
    this.state.threads = [...this.knownThreads].slice(-RELAY_THREAD_LIMIT);
  }

  /**
   * Observe the rows that one import inserted. The first batch for a
   * conversation is its baseline: a sign-in sync must not relay history.
   */
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
      for (const message of rows) {
        if (!this.accepts(message)) continue;
        this.remember(message);
        changed = true;
        if (this.queue.length >= RELAY_QUEUE_LIMIT) {
          const now = Date.now();
          this.state.lastRun = { state: 'skipped', messageId: message.id, startedAt: now, endedAt: now, error: 'relay queue is full; message dropped' };
          continue;
        }
        this.queue.push({ id: message.id, provider: message.provider, task: message.text });
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
    const run = startHarness(buildPrompt(item.task), {
      command: this.config.command,
      cwd: this.cwd,
      timeoutMs: this.config.timeoutMs,
    });
    this.active = run;
    let result: HarnessResult;
    try {
      result = await run.promise;
    } catch (error) {
      result = { ok: false, reply: '', code: null, error: `harness failed: ${(error as Error).message}` };
    } finally {
      this.active = null;
    }
    if (this.closed) return;
    if (result.ok) {
      try {
        this.enqueueReply(item.provider, result.reply.slice(0, RELAY_REPLY_LIMIT));
      } catch {
        result = { ok: false, reply: '', code: result.code, error: 'outbox write failed' };
      }
    }
    const endedAt = Date.now();
    this.state.runs += 1;
    this.state.lastRun = result.ok
      ? { state: 'ok', messageId: item.id, startedAt, endedAt }
      : { state: 'error', messageId: item.id, startedAt, endedAt, error: result.error ?? 'harness failed' };
    this.save();
  }

  status(): RelayStatus {
    const lastRun = this.state.lastRun
      ? { ...this.state.lastRun, error: this.state.lastRun.error ? redactSecrets(this.state.lastRun.error) : undefined }
      : null;
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      harness: {
        command: redactSecrets(this.config.command),
        cwd: redactSecrets(this.cwd),
        timeoutMs: this.config.timeoutMs,
      },
      pending: this.queue.length + (this.active ? 1 : 0),
      running: this.active !== null,
      processed: this.state.processed.length,
      watermark: this.state.watermark,
      lastRun,
    };
  }

  /** Stop the queue and kill the active harness run. */
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
