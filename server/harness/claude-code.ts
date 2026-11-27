import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isUuidSessionId, parseModel } from '../relay-state.js';
import { failedRun, killTree, normalizeStartOptions, splitCommand } from './process.js';
import type { Harness, HarnessResult, HarnessRun, HarnessStartOptions } from './types.js';

export const CLAUDE_CODE_COMMAND = 'claude';
export const CLAUDE_CODE_MENTION = '@claude-code';

export class ClaudeCodeHarness implements Harness {
  readonly id = 'claude-code';
  readonly mention = CLAUDE_CODE_MENTION;

  private readonly options: { command: string; cwd: string };

  constructor(options: { command: string; cwd: string }) {
    this.options = options;
  }

  async listModels(_cwd: string, signal: AbortSignal): Promise<string[] | undefined> {
    const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    if (!baseUrl || signal.aborted) return undefined;

    try {
      const url = new URL(baseUrl);
      url.pathname = url.pathname.replace(/\/+$/, '') + '/v1/models';
      const headers = new Headers();
      if (process.env.ANTHROPIC_AUTH_TOKEN) {
        headers.set('Authorization', `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`);
      }
      if (process.env.ANTHROPIC_API_KEY) headers.set('x-api-key', process.env.ANTHROPIC_API_KEY);
      headers.set('anthropic-version', '2023-06-01');
      const response = await fetch(url, {
        headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      });
      if (!response.ok) return undefined;
      const catalog = await response.json() as { data?: Array<{ id?: unknown }>; has_more?: boolean } | null;
      // A partial catalog cannot tell us whether a model is unavailable.
      if (!Array.isArray(catalog?.data) || catalog.has_more) return undefined;
      const models = catalog.data.map((entry) => parseModel(entry?.id))
        .filter((model): model is string => model !== undefined);
      return models.length ? [...new Set(models)] : undefined;
    } catch {
      return undefined;
    }
  }

  start(prompt: string, options?: HarnessStartOptions | string): HarnessRun {
    const run = normalizeStartOptions(options);
    const cwd = run.cwd ?? this.options.cwd;
    const [file, ...args] = splitCommand(this.options.command);
    if (!file) return failedRun('the Claude Code command is empty');
    if (run.sessionId && !isUuidSessionId(run.sessionId)) return failedRun('invalid Claude Code session ID');

    // Allow edits in the selected project. Skip shell tools and MCP servers.
    args.push('--print', '--output-format', 'stream-json', '--verbose',
      '--restricted', '--strict-mcp-config', '--permission-mode', 'acceptEdits');
    if (run.model) args.push('--model', run.model);
    if (run.sessionId) args.push('--resume', run.sessionId);

    const child = spawn(file, args, {
      cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      detached: process.platform !== 'win32', env: { ...process.env, PWD: cwd },
    });
    const lines = createInterface({ input: child.stdout });
    const stop = (): void => {
      killTree(child);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
    };
    let session = run.sessionId;
    let reply = '';
    let error: string | undefined;
    lines.on('line', (line) => {
      if (error) return;
      let event: { type?: unknown; subtype?: unknown; session_id?: unknown; is_error?: unknown; result?: unknown } | null;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === 'system' && event.subtype === 'init' && isUuidSessionId(event.session_id)) {
        if (session && session !== event.session_id) {
          error = 'Claude Code returned a different session ID';
          stop();
        } else if (!session) {
          session = event.session_id;
          try {
            run.onSessionCreated?.(session);
          } catch {
            error = 'could not register the Claude Code session';
            stop();
          }
        }
      }
      if (event?.type !== 'result') return;
      if (event.is_error === true || event.subtype !== 'success') {
        error = 'Claude Code reported a run error';
      } else if (event.session_id !== session) {
        error = 'Claude Code returned a different session ID';
      } else if (typeof event.result === 'string') {
        reply = event.result.trim();
      }
    });
    child.stdin.on('error', () => { /* The exit status reports a failed run. */ });
    // Keep the prompt out of the process arguments.
    child.stdin.end(prompt);
    const promise = new Promise<HarnessResult>((resolve) => {
      child.once('error', (cause: NodeJS.ErrnoException) => {
        error = `harness could not start: ${cause.code ?? 'unknown error'}`;
      });
      child.once('close', (code) => {
        if (code !== 0) error ??= `harness exited with code ${code ?? 'unknown'}`;
        if (!session) error ??= 'Claude Code did not return a session ID';
        if (!reply) error ??= 'harness returned no assistant text';
        resolve({ ok: !error, reply: error ? '' : reply, code, error });
      });
    });
    return { promise, kill: stop };
  }
}
