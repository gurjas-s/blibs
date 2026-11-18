// Local harness adapter for the relay loop.
//
// The relay turns one inbound agent message into one non-interactive harness
// run. This module owns the child process: a dedicated working directory, no
// shell, a timeout, bounded prompt and output, and an environment without the
// vendor credentials. The OpenCode CLI is the only implementation.
import { spawn } from 'node:child_process';

/** The outbox caps a reply at 4,000 characters. The harness uses the same cap. */
export const RELAY_REPLY_LIMIT = 4000;
/** Cap on captured stdout. A larger stream stops the run. */
export const HARNESS_OUTPUT_LIMIT = 64 * 1024;

export interface HarnessOptions {
  /** Configured command line. It is split, never run through a shell. */
  command: string;
  /** Scratch directory for the harness. Must not be the blibs checkout. */
  cwd: string;
  timeoutMs: number;
  /** Base environment. Vendor credentials are always removed. */
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  maxReplyChars?: number;
}

export interface HarnessResult {
  ok: boolean;
  reply: string;
  code: number | null;
  /** A fixed, bounded reason. It never contains the prompt or the child output. */
  error?: string;
}

export interface HarnessRun {
  promise: Promise<HarnessResult>;
  /** Kill the child process group. Safe to call more than one time. */
  kill(): void;
}

/** Names that hold vendor credentials. The harness never receives them. */
const SECRET_ENV = /(^|_)(EMAIL|PASSWORD)_MUSE(_|$)|(^|_)PROTON(_|$)/i;

/**
 * Split a configured command line. A JSON array keeps paths with spaces valid:
 * `["C:\\Program Files\\node.exe","C:\\fake harness.mjs"]`.
 */
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

/** Copy an environment without the Muse and Proton credentials. */
export function harnessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Remove terminal color codes from a captured reply. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
export function plainText(value: string): string {
  return value.replace(ANSI_SEQUENCE, '').trim();
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The child starts as a group leader. Kill the group so helper processes
    // from the harness do not outlive the run.
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Start one harness run. The prompt is the last argument, so the OpenCode CLI
 * receives it as the message for `opencode run`.
 */
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
    // A child that ignores SIGKILL does not keep the relay waiting.
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
