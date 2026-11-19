import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OPENCODE_MENTION } from './mention.js';
import type {
  Harness,
  HarnessMcpServer,
  HarnessResult,
  HarnessRun,
  HarnessSession,
  HarnessStartOptions,
} from './types.js';

export const HARNESS_OUTPUT_LIMIT = 64 * 1024;
/** Default opencode command. The relay uses it unless a config overrides it. */
export const OPENCODE_COMMAND = 'opencode run';
/** Default command that lists the sessions of one project. */
export const OPENCODE_SESSION_LIST_COMMAND = 'opencode session list --format json --max-count 50';
const KILL_GRACE_MS = 2000;
const SESSION_OUTPUT_LIMIT = 256 * 1024;
const SESSION_TIMEOUT_MS = 20_000;
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

export interface OpenCodeHarnessOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  sessionListCommand?: string;
}

export function splitCommand(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('harness command is not valid JSON'); }
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((part) => typeof part === 'string' && part.trim())) {
      throw new Error('harness command must be a non-empty JSON array of strings');
    }
    return parsed as string[];
  }
  return trimmed.split(/\s+/);
}

function plainText(value: string): string {
  return value.replace(ANSI_SEQUENCE, '').trim();
}

/** OpenCode reads `opencode.json` from the run directory and connects to every local MCP server in it. */
const MCP_CONFIG_FILE = 'opencode.json';

function mcpConfig(servers: HarnessMcpServer[]): string {
  const entries: Record<string, { type: string; command: string[] }> = {};
  for (const server of servers) entries[server.name] = { type: 'local', command: [...server.command] };
  return JSON.stringify({ mcp: { servers: entries } }, null, 2);
}

/**
 * Write the MCP server config for one run. Only runs that request servers
 * write the file, and only the routing runs request them, so the write never
 * touches a user project directory.
 */
function writeMcpConfig(cwd: string, servers: HarnessMcpServer[]): void {
  try {
    fs.writeFileSync(path.join(cwd, MCP_CONFIG_FILE), mcpConfig(servers));
  } catch { /* the run proceeds; the agent reports the missing tools */ }
}

function hasSessionFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--session' || arg === '-s' || arg === '--continue' || arg === '-c');
}

/** One run that fails before the harness process starts. */
function failedRun(error: string): HarnessRun {
  return { promise: Promise.resolve({ ok: false, reply: '', code: null, error }), kill() {} };
}

function hasModelFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--model' || arg === '-m');
}

function normalizeStartOptions(options?: HarnessStartOptions | string): HarnessStartOptions {
  if (typeof options === 'string') return { sessionId: options };
  return options ?? {};
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The child leads a process group, so helper processes die with it.
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** Read the JSON array from a session list. A log prefix is allowed. */
function parseSessionList(output: string): HarnessSession[] {
  let parsed: unknown;
  for (let start = output.indexOf('['); start !== -1; start = output.indexOf('[', start + 1)) {
    const end = output.lastIndexOf(']');
    if (end <= start) break;
    try {
      parsed = JSON.parse(output.slice(start, end + 1));
      break;
    } catch { /* try the next array start */ }
  }
  if (!Array.isArray(parsed)) throw new Error('session list returned no JSON array');
  const sessions: HarnessSession[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== 'string') continue;
    const id = raw.id.trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) continue;
    const session: HarnessSession = { id };
    if (typeof raw.title === 'string' && raw.title.trim()) session.title = raw.title.trim().slice(0, 200);
    if (typeof raw.updated === 'number' && Number.isFinite(raw.updated)) session.updated = raw.updated;
    sessions.push(session);
    if (sessions.length >= 50) break;
  }
  return sessions;
}

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode';
  readonly mention = OPENCODE_MENTION;

  private readonly command: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly sessionListCommand: string;

  constructor(options: OpenCodeHarnessOptions) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes ?? HARNESS_OUTPUT_LIMIT;
    this.sessionListCommand = options.sessionListCommand ?? OPENCODE_SESSION_LIST_COMMAND;
  }

  start(prompt: string, options?: HarnessStartOptions | string): HarnessRun {
    const run = normalizeStartOptions(options);
    const cwd = run.cwd ?? this.cwd;
    const command = splitCommand(this.command);
    const maxOutput = this.maxOutputBytes;
    if (!command.length) return failedRun('harness command is empty');
    const [file, ...args] = command;
    const finalArgs = [...args];
    if (run.sessionId && !hasSessionFlag(finalArgs)) finalArgs.push('--session', run.sessionId);
    if (run.model && !hasModelFlag(finalArgs)) finalArgs.push('--model', run.model);
    finalArgs.push(prompt);
    if (run.mcp?.length) writeMcpConfig(cwd, run.mcp);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, finalArgs, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        // Node keeps the parent PWD in the child env. Tools that read $PWD
        // for their location must see the harness directory, not ours.
        env: { ...process.env, PWD: cwd },
      });
    } catch (error) {
      return failedRun(`harness could not start: ${(error as Error).message}`);
    }

    let output = '';
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let resolveRun: (result: HarnessResult) => void = () => {};
    const promise = new Promise<HarnessResult>((resolve) => { resolveRun = resolve; });
    const finish = (result: HarnessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Do not wait forever for a child that ignores SIGKILL.
      setTimeout(() => finish({ ok: false, reply: '', code: null, error: `harness timed out after ${this.timeoutMs} ms` }), KILL_GRACE_MS);
    }, this.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (overflow) return;
      output += chunk;
      if (output.length > maxOutput) {
        overflow = true;
        killTree(child);
      }
    });
    // opencode can repeat the prompt on stderr, so the relay never keeps it.
    child.stderr?.resume();

    child.once('error', (error) => {
      finish({ ok: false, reply: '', code: null, error: `harness could not start: ${error.message}` });
    });
    child.once('close', (code) => {
      if (timedOut) return finish({ ok: false, reply: '', code, error: `harness timed out after ${this.timeoutMs} ms` });
      if (overflow) return finish({ ok: false, reply: '', code, error: `harness output exceeded ${maxOutput} bytes` });
      if (code !== 0) return finish({ ok: false, reply: '', code, error: `harness exited with code ${code ?? 'unknown'}` });
      const reply = plainText(output);
      if (!reply) return finish({ ok: false, reply: '', code, error: 'harness returned no assistant text' });
      finish({ ok: true, reply, code });
    });

    return { promise, kill: () => killTree(child) };
  }

  async listSessions(cwd: string): Promise<HarnessSession[]> {
    const command = splitCommand(this.sessionListCommand);
    if (!command.length) throw new Error('session list command is empty');
    const [file, ...args] = command;
    const timeoutMs = Math.min(this.timeoutMs, SESSION_TIMEOUT_MS);
    const output = await new Promise<string>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: { ...process.env, PWD: cwd },
        });
      } catch (error) {
        reject(new Error(`session list could not start: ${(error as Error).message}`));
        return;
      }
      let text = '';
      let settled = false;
      const finish = (error?: string, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(new Error(error));
        else resolve(value ?? '');
      };
      const timer = setTimeout(() => {
        killTree(child);
        finish(`session list timed out after ${timeoutMs} ms`);
      }, timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (settled) return;
        text += chunk;
        if (text.length > SESSION_OUTPUT_LIMIT) {
          killTree(child);
          finish(`session list output exceeded ${SESSION_OUTPUT_LIMIT} bytes`);
        }
      });
      child.stderr?.resume();
      child.once('error', (error) => finish(`session list could not start: ${error.message}`));
      child.once('close', (code) => {
        if (code !== 0) finish(`session list exited with code ${code ?? 'unknown'}`);
        else finish(undefined, text);
      });
    });
    return parseSessionList(output);
  }
}
