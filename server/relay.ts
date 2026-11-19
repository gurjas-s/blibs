import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryMessage } from './history.js';
import { DEFAULT_DISCOVERY_ROOT, DEFAULT_PROJECTS } from './relay-defaults.js';
import type { Harness, HarnessMcpServer, HarnessResult, HarnessRun } from './harness/types.js';
import { extractMentionTask, sanitizeReply, stripVendorLabel } from './harness/mention.js';
import { isBlibsMention, isIntroMessage, introMessage } from './harness/intro.js';
import type { HarnessChoice } from './harness/intro.js';
import { harnessMessage } from './harness/message.js';
import { ROUTING_MCP_NAME, ROUTING_QUESTION_LIMIT, parseRoutingReply, routingPrompt } from './harness/routing-agent.js';
import type { RoutingDecision } from './harness/routing-agent.js';
import { HARNESS_KINDS, harnessKind } from './harness/registry.js';
import {
  RELAY_PROCESSED_LIMIT,
  RELAY_SESSION_LIMIT,
  RELAY_STATE_VERSION,
  RELAY_THREAD_LIMIT,
  parseHarnesses,
  parseModel,
  parseRelayRun,
  parseSessionId,
  parseSessions,
  parseStringArray,
  readRelayStateFile,
} from './relay-state.js';
import type { RelayRunState, RelayState } from './relay-state.js';
import {
  canonicalDir,
  clarificationText,
  expandHome,
  isAllowedProject,
  listCandidates,
  resolveProject,
  resolveRegistryPaths,
  sessionKey,
  sessionKeyPrefix,
  threadProjects,
} from './harness/router.js';
import type { ProjectRegistry } from './harness/router.js';

export const RELAY_QUEUE_LIMIT = 20;
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000;
export const RELAY_PROVIDER = 'muse';
/** Environment override for the harness command. Tests and e2e stub the routing agent with it. */
export const RELAY_COMMAND_ENV = 'BLIBS_RELAY_COMMAND';
/** Length limit for one stored or env harness command. */
const RELAY_COMMAND_LIMIT = 2000;
/** Window that treats the same trigger text in one thread as a re-scrape. */
const TRIGGER_DEDUPE_MS = 2 * 60_000;
/** Trigger keys kept in memory. */
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
  /** Approved project directories. */
  projects: string[];
  /** Directory whose subdirectories are project candidates. */
  discoveryRoot: string;
}

export interface RelayStatus {
  enabled: boolean;
  provider: string;
  harness: { id: string; command: string; cwd: string; timeoutMs: number; model?: string };
  /** Harness rows the panel reported for the introduction reply. */
  harnesses: HarnessChoice[];
  projects: string[];
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
  task: string;
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
  // The registry owns the harness default. An explicit command override wins
  // over the environment, and an unknown harness id falls back to the default.
  const kind = harnessKind(overrides.harnessId);
  const config: RelayConfig = {
    enabled: true,
    provider: RELAY_PROVIDER,
    cwd: path.join(dataDir, 'harness'),
    timeoutMs: DEFAULT_RELAY_TIMEOUT_MS,
    model: undefined,
    ...overrides,
    projects: overrides.projects ?? DEFAULT_PROJECTS,
    discoveryRoot: overrides.discoveryRoot ?? DEFAULT_DISCOVERY_ROOT,
    harnessId: kind.id,
    command: overrides.command ?? (envCommand ? envCommand.slice(0, RELAY_COMMAND_LIMIT) : kind.defaultCommand),
  };
  const registry = resolveRegistryPaths(config.discoveryRoot, config.projects);
  return {
    ...config,
    cwd: canonicalDir(safeHarnessCwd(path.resolve(config.cwd), dataDir)),
    projects: registry.projects,
    discoveryRoot: registry.discoveryRoot,
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
          routerSessionId: undefined,
          projects: options.config.projects.map(canonicalDir),
          discoveryRoot: canonicalDir(options.config.discoveryRoot),
          model: options.config.model,
          harnesses: [],
          runs: 0,
          lastRun: null,
        };
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
    const projects = Array.isArray(raw.projects) ? parseStringArray(raw.projects) : this.config.projects;
    const registry = resolveRegistryPaths(
      typeof raw.discoveryRoot === 'string' && raw.discoveryRoot.trim() ? raw.discoveryRoot : this.config.discoveryRoot,
      projects,
    );
    return {
      version: RELAY_STATE_VERSION,
      watermark: typeof raw.watermark === 'number' && Number.isFinite(raw.watermark) ? raw.watermark : Date.now(),
      processed: parseStringArray(raw.processed, RELAY_PROCESSED_LIMIT),
      threads: parseStringArray(raw.threads, RELAY_THREAD_LIMIT),
      sessions: parseSessions(raw.sessions),
      routerSessionId: parseSessionId(raw.routerSessionId),
      projects: registry.projects.map(canonicalDir),
      discoveryRoot: canonicalDir(registry.discoveryRoot),
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
      const prefix = sessionKeyPrefix(oldest);
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
    if (keys.length > RELAY_SESSION_LIMIT) delete this.state.sessions[keys[0]];
    return created;
  }

  /** Project paths with sessions in one provider conversation, most recent last. */
  projectsFor(threadId: string): string[] {
    return threadProjects(this.state.sessions, threadId);
  }

  /** Approved projects and the discovery root. The registry persists in state. */
  registry(): ProjectRegistry {
    return { projects: [...this.state.projects], discoveryRoot: this.state.discoveryRoot };
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

  /** Replace the harness rows that the introduction reply lists. */
  updateHarnesses(reported: HarnessChoice[]): RelayStatus {
    this.state.harnesses = reported.map((choice) => ({ ...choice }));
    this.save();
    return this.status();
  }

  /** Record and send one introduction reply. It is not a harness run. */
  private announceIntro(message: HistoryMessage): void {
    const text = introMessage(this.harnesses());
    // The reply must reach the conversation that asked. Keep the example tag,
    // because `isIntroMessage` stops the echo from starting a run.
    this.tellProvider(message, text, false);
    try {
      this.announceReply(message.provider, text, message.threadId, message.id);
    } catch { /* the next @blibs message retries */ }
  }

  /** Replace the registry. The caller validates the shape before this call. */
  updateRegistry(projects: string[], discoveryRoot: string, model?: string | null): RelayStatus {
    const resolved = resolveRegistryPaths(discoveryRoot, projects);
    try { fs.mkdirSync(resolved.discoveryRoot, { recursive: true }); } catch { /* discovery stays optional */ }
    for (const dir of resolved.projects) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* a run records the failure */ }
    }
    this.state.projects = resolved.projects.map(canonicalDir);
    this.state.discoveryRoot = canonicalDir(resolved.discoveryRoot);
    this.state.model = model === null ? undefined : (model ?? this.state.model);
    if (model !== undefined) this.config = { ...this.config, model: model ?? undefined };
    this.save();
    return this.status();
  }

  /** Registered projects plus discovery subdirectories. */
  candidates(): string[] {
    return listCandidates(this.registry());
  }

  /** The routing agent session. One persistent session serves every thread. */
  private routerSession(): string {
    if (this.state.routerSessionId) return this.state.routerSessionId;
    const created = newSessionId();
    this.state.routerSessionId = created;
    this.save();
    return created;
  }

  /** The blibs-router MCP server the routing run must expose to the agent. */
  private routerMcp(): HarnessMcpServer {
    return {
      name: ROUTING_MCP_NAME,
      command: [process.execPath, path.join(MODULE_DIR, 'router-mcp.js'), '--data-dir', this.stateDir],
    };
  }

  /**
   * Canonicalize one project the routing agent picked and check it against
   * the allowlist. Null means the path is not an approved project.
   */
  private allowedProject(target: string): string | null {
    const projectPath = canonicalDir(path.resolve(expandHome(target)));
    if (!isAllowedProject(projectPath, this.registry(), this.config.cwd)) return null;
    try { fs.mkdirSync(projectPath, { recursive: true }); } catch { /* the run records the failure */ }
    return projectPath;
  }

  /** Keyword fallback for a decision the routing agent did not make. */
  private heuristicProject(item: RelayItem): string | null {
    // A stored session can outlive its project entry. Only an allowed project
    // can win, or one stale session would hide the current registry.
    const known = this.projectsFor(item.threadId)
      .filter((dir) => isAllowedProject(dir, this.registry(), this.config.cwd));
    const candidates = this.candidates();
    if (known.length === 0 && candidates.length === 0) {
      return this.config.cwd;
    }
    const resolved = resolveProject(item.task, known, candidates);
    if (!resolved) return null;
    return this.allowedProject(resolved.projectPath);
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

  /** Send one short failure note so a silent run is visible in the chat. */
  private tellFailure(item: RelayItem, text: string): void {
    this.tellProvider(item, text.trim().slice(0, 300));
  }

  /**
   * True when the same trigger text already ran in this thread. A vendor page
   * can re-scrape one bubble with a new position, which gives it a new message
   * id. The text and the thread are the stable part.
   */
  private seenTrigger(threadId: string, kind: 'intro' | 'task', text: string): boolean {
    const key = `${threadId}\n${kind}\n${text.replace(/\s+/g, ' ').trim()}`;
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

  /** Drop the recent triggers of one thread. A `/clear` resets the chat context. */
  private clearTriggers(threadId: string): void {
    const prefix = `${threadId}\n`;
    for (const key of [...this.recentTriggers.keys()]) {
      if (key.startsWith(prefix)) this.recentTriggers.delete(key);
    }
  }

  private isClearCommand(text: string): boolean {
    return stripVendorLabel(text).trim().toLowerCase() === '/clear';
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
          this.remember(row);
          // An introduction is safe to answer once, even on a baseline batch.
          if (!isIntroMessage(row.text) && isBlibsMention(row.text)
            && !this.seenTrigger(threadId, 'intro', stripVendorLabel(row.text))) {
            this.announceIntro(row);
          }
          // A baseline task must not run when a later scrape re-renders it.
          const task = extractMentionTask(row.text, this.harness.mention);
          if (task !== null) this.seenTrigger(threadId, 'task', task);
        }
        changed = true;
        continue;
      }
      for (const message of rows) {
        if (isIntroMessage(message.text)) continue;
        if (this.isClearCommand(message.text)) {
          if (!this.accepts(message)) continue;
          this.remember(message);
          changed = true;
          this.clearTriggers(threadId);
          continue;
        }
        if (isBlibsMention(message.text)) {
          if (!this.accepts(message)) continue;
          this.remember(message);
          changed = true;
          if (!this.seenTrigger(threadId, 'intro', stripVendorLabel(message.text))) {
            this.announceIntro(message);
          }
          continue;
        }
        const task = extractMentionTask(message.text, this.harness.mention);
        if (task === null) continue;
        if (!this.accepts(message)) continue;
        // The routing agent resolves the project when the queue drains, so
        // the queue only carries the provider task.
        this.remember(message);
        changed = true;
        if (this.seenTrigger(threadId, 'task', task)) continue;
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

    // Phase 1: the routing agent resolves the project through the MCP tools.
    const routing = await this.runRoutingAgent(item);
    if (this.closed) return;
    if (routing.error) {
      // A failed routing run forwards nothing, so send the reason instead.
      this.tellFailure(
        item,
        `The ${harnessKind(this.config.harnessId).name} routing agent failed: ${routing.error}. Check the ${harnessKind(this.config.harnessId).name} model and command.`,
      );
      return this.finishRun(item.id, startedAt, false, routing.error);
    }

    // Phase 2: forward the provider message to the resolved session.
    if (routing.decision?.kind === 'ask') {
      const question = routing.decision.question?.trim();
      if (question) {
        this.tellProvider(item, question.slice(0, ROUTING_QUESTION_LIMIT));
        return this.finishRun(item.id, startedAt, true);
      }
    }
    let projectPath: string | null = null;
    if (routing.decision?.kind === 'forward' && routing.decision.projectPath) {
      projectPath = this.allowedProject(routing.decision.projectPath);
    }
    // No agent decision, or a rejected path: the keyword resolver takes over.
    if (projectPath === null) projectPath = this.heuristicProject(item);
    if (!projectPath) {
      this.tellProvider(item, clarificationText(this.candidates(), this.projectsFor(item.threadId)));
      return this.finishRun(item.id, startedAt, true);
    }
    await this.runWork(item, projectPath, startedAt);
  }

  private async runRoutingAgent(item: RelayItem): Promise<{ decision: RoutingDecision | null; error?: string }> {
    const run = this.harness.start(
      routingPrompt(item.task, item.threadId),
      {
        sessionId: this.routerSession(),
        cwd: this.config.cwd,
        model: this.config.model,
        mcp: [this.routerMcp()],
      },
    );
    try {
      const result = await this.awaitRun(run);
      if (!result.ok) return { decision: null, error: result.error };
      return { decision: parseRoutingReply(result.reply) };
    } catch (e) {
      return { decision: null, error: `routing agent failed: ${(e as Error).message}` };
    }
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

  private async runWork(item: RelayItem, projectPath: string, startedAt: number): Promise<void> {
    const run = this.harness.start(buildPrompt(item.task), {
      sessionId: this.sessionFor(item.threadId, projectPath),
      cwd: projectPath,
      model: this.config.model,
    });
    let ok = false;
    let error: string | undefined;
    try {
      const result = await this.awaitRun(run);
      error = result.error;
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
    this.state.runs += 1;
    this.state.lastRun = ok
      ? { state: 'ok', messageId, startedAt, endedAt: Date.now() }
      : { state: 'error', messageId, startedAt, endedAt: Date.now(), error: error ?? 'routing failed' };
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
      projects: [...this.state.projects],
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
