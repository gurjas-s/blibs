import type { spawn } from 'node:child_process';
import type { HarnessRun, HarnessStartOptions } from './types.js';

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

/** One run that fails before the harness process starts. */
export function failedRun(error: string): HarnessRun {
  return { promise: Promise.resolve({ ok: false, reply: '', code: null, error }), kill() {} };
}

export function normalizeStartOptions(options?: HarnessStartOptions | string): HarnessStartOptions {
  if (typeof options === 'string') return { sessionId: options };
  return options ?? {};
}

export function killTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The child leads a process group, so helper processes die with it.
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
