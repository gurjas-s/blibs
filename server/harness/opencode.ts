import { spawn } from 'node:child_process';
import { OPENCODE_MENTION } from './mention.js';
import type { Harness, HarnessResult, HarnessRun, HarnessStartOptions } from './types.js';

export const HARNESS_OUTPUT_LIMIT = 64 * 1024;
/** Default opencode command. The relay uses it unless a config overrides it. */
export const OPENCODE_COMMAND = 'opencode run';
const KILL_GRACE_MS = 2000;
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

export interface OpenCodeHarnessOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
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

function hasSessionFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--session' || arg === '-s' || arg === '--continue' || arg === '-c');
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

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode';
  readonly mention = OPENCODE_MENTION;

  private readonly command: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: OpenCodeHarnessOptions) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes ?? HARNESS_OUTPUT_LIMIT;
  }

  start(prompt: string, options?: HarnessStartOptions | string): HarnessRun {
    const run = normalizeStartOptions(options);
    const cwd = run.cwd ?? this.cwd;
    const command = splitCommand(this.command);
    const maxOutput = this.maxOutputBytes;
    if (!command.length) {
      return { promise: Promise.resolve({ ok: false, reply: '', code: null, error: 'harness command is empty' }), kill() {} };
    }
    const [file, ...args] = command;
    const finalArgs = [...args];
    if (run.sessionId && !hasSessionFlag(finalArgs)) finalArgs.push('--session', run.sessionId);
    if (run.model && !hasModelFlag(finalArgs)) finalArgs.push('--model', run.model);
    finalArgs.push(prompt);

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
      return { promise: Promise.resolve({ ok: false, reply: '', code: null, error: `harness could not start: ${(error as Error).message}` }), kill() {} };
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
}
