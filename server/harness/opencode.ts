import { spawn } from 'node:child_process';
import { OPENCODE_MENTION } from './mention.js';
import type {
  Harness,
  HarnessDiagnostics,
  HarnessResult,
  HarnessRun,
  HarnessStartOptions,
} from './types.js';

export const HARNESS_OUTPUT_LIMIT = 64 * 1024;
/** Default opencode command. The relay uses it unless a config overrides it. */
export const OPENCODE_COMMAND = 'opencode run';
const PROGRESS_INTERVAL_MS = 60_000;
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

export interface OpenCodeHarnessOptions {
  command: string;
  cwd: string;
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

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode';
  readonly mention = OPENCODE_MENTION;

  private readonly command: string;
  private readonly cwd: string;
  private readonly maxOutputBytes: number;

  constructor(options: OpenCodeHarnessOptions) {
    this.command = options.command;
    this.cwd = options.cwd;
    this.maxOutputBytes = options.maxOutputBytes ?? HARNESS_OUTPUT_LIMIT;
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

    const startedAt = performance.now();
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
    let settled = false;
    let spawned = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastOutputAt: number | null = null;
    let spawnErrorCode: string | null = null;
    const diagnostics = (): HarnessDiagnostics => ({
      elapsedMs: Math.round(performance.now() - startedAt),
      spawned,
      processExited: child.exitCode !== null || child.signalCode !== null,
      stdoutBytes,
      stderrBytes,
      lastOutputAgoMs: lastOutputAt === null ? null : Math.round(performance.now() - lastOutputAt),
      signal: child.signalCode,
      spawnErrorCode,
    });
    let resolveRun: (result: HarnessResult) => void = () => {};
    const promise = new Promise<HarnessResult>((resolve) => { resolveRun = resolve; });
    const finish = (result: HarnessResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      resolveRun({ ...result, diagnostics: diagnostics() });
    };

    const progressTimer = run.onProgress && setInterval(() => {
      run.onProgress?.(diagnostics());
    }, PROGRESS_INTERVAL_MS);
    const stop = (): void => {
      killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    child.once('spawn', () => { spawned = true; });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      lastOutputAt = performance.now();
      if (overflow) return;
      if (stdoutBytes > maxOutput) {
        overflow = true;
        stop();
        return;
      }
      output += chunk;
    });
    // OpenCode can repeat the prompt on stderr. Count bytes and discard the text.
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      lastOutputAt = performance.now();
    });

    child.once('error', (error) => {
      spawnErrorCode = (error as NodeJS.ErrnoException).code ?? null;
      finish({ ok: false, reply: '', code: null, error: `harness could not start: ${spawnErrorCode ?? 'unknown error'}` });
    });
    child.once('close', (code) => {
      if (overflow) return finish({ ok: false, reply: '', code, error: `harness output exceeded ${maxOutput} bytes` });
      if (code !== 0) return finish({ ok: false, reply: '', code, error: `harness exited with code ${code ?? 'unknown'}` });
      const reply = plainText(output);
      if (!reply) return finish({ ok: false, reply: '', code, error: 'harness returned no assistant text' });
      finish({ ok: true, reply, code });
    });

    return { promise, kill: stop };
  }
}
