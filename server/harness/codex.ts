import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isCodexSessionId, parseModel } from '../relay-state.js';
import { failedRun, killTree, normalizeStartOptions, splitCommand } from './process.js';
import type { Harness, HarnessResult, HarnessRun, HarnessStartOptions } from './types.js';

export const CODEX_COMMAND = 'codex exec';
export const CODEX_MENTION = '@codex';

export class CodexHarness implements Harness {
  readonly id = 'codex';
  readonly mention = CODEX_MENTION;

  private readonly options: { command: string; cwd: string };

  constructor(options: { command: string; cwd: string }) {
    this.options = options;
  }

  listModels(cwd: string, signal: AbortSignal): Promise<string[] | undefined> {
    const [file, ...args] = splitCommand(this.options.command);
    const exec = args.indexOf('exec');
    if (!file || exec === -1 || signal.aborted) return Promise.resolve(undefined);

    const child = spawn(file, [...args.slice(0, exec), 'app-server'], {
      cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      detached: process.platform !== 'win32', env: { ...process.env, PWD: cwd },
    });
    const lines = createInterface({ input: child.stdout });
    return new Promise((resolve) => {
      const models = new Set<string>();
      let settled = false;
      const finish = (result?: string[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        lines.close();
        child.stdout.destroy();
        child.stdin.destroy();
        killTree(child);
        resolve(result);
      };
      const cancel = (): void => finish();
      const timer = setTimeout(cancel, 5_000);
      const send = (message: object): void => {
        child.stdin.write(JSON.stringify(message) + '\n');
      };
      const cursors = new Set<string>();
      const list = (cursor?: string): void => send({
        id: 2, method: 'model/list', params: { cursor, includeHidden: true },
      });
      signal.addEventListener('abort', cancel, { once: true });
      child.once('error', cancel);
      child.once('close', cancel);
      child.stdin.on('error', cancel);
      lines.on('line', (line) => {
        let response: { id?: unknown; result?: { data?: unknown; nextCursor?: unknown } } | null;
        try { response = JSON.parse(line); } catch { return; }
        if (response?.id === 1 && response.result) {
          send({ method: 'initialized' });
          list();
        } else if (response?.id === 2) {
          const { data, nextCursor } = response.result ?? {};
          if (!Array.isArray(data)) return finish();
          for (const entry of data) {
            const id = parseModel(entry?.model);
            if (id) models.add(id);
          }
          if (typeof nextCursor === 'string' && nextCursor.length && !cursors.has(nextCursor)) {
            cursors.add(nextCursor);
            list(nextCursor);
          } else {
            finish(nextCursor || !models.size ? undefined : [...models]);
          }
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'blibs', version: '0.1.0' } } });
    });
  }

  start(prompt: string, options?: HarnessStartOptions | string): HarnessRun {
    const run = normalizeStartOptions(options);
    const cwd = run.cwd ?? this.options.cwd;
    const [file, ...args] = splitCommand(this.options.command);
    if (!file || args.at(-1) !== 'exec') return failedRun('the Codex command must end with exec');
    if (run.sessionId && !isCodexSessionId(run.sessionId)) return failedRun('invalid Codex session ID');

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blibs-codex-'));
    const output = path.join(outputDir, 'reply.txt');
    const cleanup = (): void => { fs.rmSync(outputDir, { recursive: true, force: true }); };
    args.push('--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'approval_policy=never');
    if (run.sessionId) args.push('resume');
    args.push('--json', '--output-last-message', output);
    if (run.model) args.push('--model', run.model);
    if (run.sessionId) args.push(run.sessionId);
    // Use stdin so the prompt is not exposed in the process arguments.
    args.push('--', '-');

    let child;
    try {
      child = spawn(file, args, {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32', env: { ...process.env, PWD: cwd },
      });
    } catch {
      cleanup();
      return failedRun('harness could not start');
    }

    const startedAt = performance.now();
    let spawned = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastOutputAt: number | null = null;
    let spawnErrorCode: string | null = null;
    let session = run.sessionId;
    let turnCompleted = false;
    let error: string | undefined;
    const lines = createInterface({ input: child.stdout });
    const stop = (): void => {
      killTree(child);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.once('spawn', () => { spawned = true; });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      lastOutputAt = performance.now();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      lastOutputAt = performance.now();
    });
    lines.on('line', (line) => {
      if (error) return;
      let event: { type?: unknown; thread_id?: unknown } | null;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === 'thread.started' && isCodexSessionId(event.thread_id)) {
        if (session && session !== event.thread_id) {
          error = 'Codex returned a different session ID';
          stop();
          return;
        }
        if (session) return;
        session = event.thread_id;
        try {
          run.onSessionCreated?.(session);
        } catch {
          error = 'could not register the Codex session';
          stop();
        }
      }
      if (event?.type === 'turn.completed') turnCompleted = true;
      if (event?.type === 'turn.failed') error = 'Codex reported a run error';
    });
    child.stdin.on('error', () => { /* The exit status reports a failed run. */ });
    child.stdin.end(prompt);
    child.once('error', (cause: NodeJS.ErrnoException) => {
      spawnErrorCode = cause.code ?? null;
      error = `harness could not start: ${spawnErrorCode ?? 'unknown error'}`;
    });

    const promise = new Promise<HarnessResult>((resolve) => {
      child.once('close', (code) => {
        let reply = '';
        if (code !== 0) error ??= `harness exited with code ${code ?? 'unknown'}`;
        if (!error && !session) error = 'Codex did not return a session ID';
        if (!error && !turnCompleted) error = 'Codex did not complete the turn';
        if (!error) {
          try { reply = fs.readFileSync(output, 'utf8').trim(); } catch { /* No final reply. */ }
          if (!reply) error = 'harness returned no assistant text';
        }
        cleanup();
        resolve({
          ok: !error, reply, code, error,
          diagnostics: {
            elapsedMs: Math.round(performance.now() - startedAt), spawned,
            processExited: child.exitCode !== null || child.signalCode !== null,
            stdoutBytes, stderrBytes,
            lastOutputAgoMs: lastOutputAt === null ? null : Math.round(performance.now() - lastOutputAt),
            signal: child.signalCode, spawnErrorCode,
          },
        });
      });
    });
    return { promise, kill: stop };
  }
}
