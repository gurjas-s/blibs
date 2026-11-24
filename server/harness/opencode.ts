import { execFile, spawn } from 'node:child_process';
import { isSessionId } from '../relay-state.js';
import { failedRun, killTree, normalizeStartOptions, splitCommand } from './process.js';
import { OPENCODE_MENTION } from './mention.js';
import type {
  Harness,
  HarnessDiagnostics,
  HarnessResult,
  HarnessRun,
  HarnessStartOptions,
} from './types.js';

/** Default opencode command. The relay uses it unless a config overrides it. */
export const OPENCODE_COMMAND = 'opencode run';
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

export interface OpenCodeHarnessOptions {
  command: string;
  cwd: string;
}

function plainText(value: string): string {
  return value.replace(ANSI_SEQUENCE, '').trim();
}

function hasSessionFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--session' || arg === '-s' || arg === '--continue' || arg === '-c'
    || /^(?:--session|-s|--continue|-c)=/.test(arg));
}

function setFlag(args: string[], flags: string[], value: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flags.includes(arg)) index += 1;
    else if (!flags.some((flag) => arg.startsWith(`${flag}=`))) result.push(arg);
  }
  return [...result, flags[0], value];
}

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode';
  readonly mention = OPENCODE_MENTION;

  private readonly command: string;
  private readonly cwd: string;

  constructor(options: OpenCodeHarnessOptions) {
    this.command = options.command;
    this.cwd = options.cwd;
  }

  listModels(cwd: string, signal: AbortSignal): Promise<string[] | undefined> {
    const [file, ...args] = splitCommand(this.command);
    const run = args.indexOf('run');
    if (!file || run === -1) return Promise.resolve(undefined);
    const modelCommand = [...args.slice(0, run), 'models'];
    return new Promise((resolve) => {
      execFile(file, modelCommand, { cwd, signal, timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(undefined);
        const models = plainText(stdout).split(/\r?\n/).map((line) => line.trim())
          .filter((id) => id.length <= 200 && /^[\w.-]+\/[\w.@:+/-]+$/.test(id));
        resolve(models.length ? [...new Set(models)] : undefined);
      });
    });
  }

  start(prompt: string, options?: HarnessStartOptions | string): HarnessRun {
    const run = normalizeStartOptions(options);
    const cwd = run.cwd ?? this.cwd;
    const command = splitCommand(this.command);
    if (!command.length) return failedRun('harness command is empty');
    const [file, ...args] = command;
    let finalArgs = run.model ? setFlag(args, ['--model', '-m'], run.model) : args;
    const onSessionCreated = run.onSessionCreated;
    if (onSessionCreated) {
      // An explicit continuation flag would make /new reuse another session.
      if (hasSessionFlag(finalArgs)) return failedRun('remove session flags from the OpenCode command to start a new session');
    } else if (run.sessionId && !hasSessionFlag(finalArgs)) {
      finalArgs.push('--session', run.sessionId);
    }
    finalArgs = setFlag(finalArgs, ['--format'], 'json');
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

    let stepText = '';
    let finalText = '';
    let eventBuffer = '';
    let session = run.sessionId;
    let sessionWriteFailed = false;
    let eventError = false;
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
      resolveRun({ ...result, diagnostics: diagnostics() });
    };

    const stop = (): void => {
      killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    function consumeEvent(line: string): void {
      let event: { type?: unknown; sessionID?: unknown; part?: { text?: unknown; reason?: unknown } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || !isSessionId(event.sessionID)) return;
      if (!session) {
        session = event.sessionID;
        try {
          onSessionCreated?.(session);
        } catch {
          sessionWriteFailed = true;
          stop();
          return;
        }
      }
      if (event.sessionID !== session) return;
      if (event.type === 'error') eventError = true;
      if (event.type === 'step_start') {
        stepText = '';
        finalText = '';
      }
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        stepText += event.part.text;
      }
      if (event.type === 'step_finish' && event.part?.reason !== 'tool-calls') {
        finalText = stepText;
      }
    }

    child.once('spawn', () => { spawned = true; });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      lastOutputAt = performance.now();
      const lines = (eventBuffer + chunk).split('\n');
      eventBuffer = lines.pop() ?? '';
      for (const line of lines) {
        consumeEvent(line);
        if (sessionWriteFailed) return;
      }
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
      if (!sessionWriteFailed && eventBuffer) consumeEvent(eventBuffer);
      if (sessionWriteFailed) return finish({ ok: false, reply: '', code, error: 'could not register the OpenCode session' });
      if (code !== 0) return finish({ ok: false, reply: '', code, error: `harness exited with code ${code ?? 'unknown'}` });
      if (onSessionCreated && !session) {
        return finish({ ok: false, reply: '', code, error: 'OpenCode did not return a session ID' });
      }
      if (eventError) return finish({ ok: false, reply: '', code, error: 'OpenCode reported a run error' });
      const reply = plainText(finalText);
      if (!reply) return finish({ ok: false, reply: '', code, error: 'harness returned no assistant text' });
      finish({ ok: true, reply, code });
    });

    return { promise, kill: stop };
  }
}
