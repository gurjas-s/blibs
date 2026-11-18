// Harness adapter: one non-interactive child process in a scratch directory,
// without a shell and without the vendor credentials.
import { spawn } from 'node:child_process';

/** The outbox caps a reply at 4,000 characters. */
export const RELAY_REPLY_LIMIT = 4000;
/** A larger stdout stream stops the run. */
export const HARNESS_OUTPUT_LIMIT = 64 * 1024;

export interface HarnessOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  maxReplyChars?: number;
}

export interface HarnessResult {
  ok: boolean;
  reply: string;
  code: number | null;
  /** Fixed reason; never the prompt or the child output. */
  error?: string;
}

export interface HarnessRun {
  promise: Promise<HarnessResult>;
  /** Kills the child group. */
  kill(): void;
}

const SECRET_ENV = /(^|_)(EMAIL|PASSWORD)_MUSE(_|$)|(^|_)PROTON(_|$)/i;

/** Split a command. A JSON array keeps paths with spaces valid. */
export function splitCommand(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('BLIBS_HARNESS_CMD is not valid JSON.'); }
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((part) => typeof part === 'string' && part.trim())) {
      throw new Error('BLIBS_HARNESS_CMD must be a non-empty JSON array of strings.');
    }
    return parsed as string[];
  }
  return trimmed.split(/\s+/);
}

export function harnessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  return env;
}

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
export function plainText(value: string): string {
  return value.replace(ANSI_SEQUENCE, '').trim();
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The child is a group leader, so helper processes die with it.
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** Start one run. The prompt is the last argument for `opencode run`. */
export function startHarness(prompt: string, options: HarnessOptions): HarnessRun {
  const command = splitCommand(options.command);
  const maxOutput = options.maxOutputBytes ?? HARNESS_OUTPUT_LIMIT;
  const maxReply = options.maxReplyChars ?? RELAY_REPLY_LIMIT;
  if (!command.length) {
    return { promise: Promise.resolve({ ok: false, reply: '', code: null, error: 'harness command is empty' }), kill() {} };
  }
  const [file, ...args] = command;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(file, [...args, prompt], {
      cwd: options.cwd,
      env: harnessEnv(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
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
    setTimeout(() => finish({ ok: false, reply: '', code: null, error: `harness timed out after ${options.timeoutMs} ms` }), 2000);
  }, options.timeoutMs);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (overflow) return;
    output += chunk;
    if (output.length > maxOutput) {
      overflow = true;
      killTree(child);
    }
  });
  // Drain stderr. The relay does not keep it; it can repeat the prompt.
  child.stderr?.resume();

  child.once('error', (error) => {
    finish({ ok: false, reply: '', code: null, error: `harness could not start: ${error.message}` });
  });
  child.once('close', (code) => {
    if (timedOut) return finish({ ok: false, reply: '', code, error: `harness timed out after ${options.timeoutMs} ms` });
    if (overflow) return finish({ ok: false, reply: '', code, error: `harness output exceeded ${maxOutput} bytes` });
    if (code !== 0) return finish({ ok: false, reply: '', code, error: `harness exited with code ${code ?? 'unknown'}` });
    const reply = plainText(output).slice(0, maxReply);
    if (!reply) return finish({ ok: false, reply: '', code, error: 'harness returned no assistant text' });
    finish({ ok: true, reply, code });
  });

  return { promise, kill: () => killTree(child) };
}
