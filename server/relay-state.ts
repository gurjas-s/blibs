// On-disk relay state.
//
// The relay service and the router MCP server read the same state file. This
// module owns the file shape, its limits, and its parsers, so both processes
// agree on the data.
import fs from 'node:fs';

export const RELAY_STATE_VERSION = 2;
export const RELAY_PROCESSED_LIMIT = 500;
export const RELAY_THREAD_LIMIT = 500;
/** Coding sessions kept in state. One thread can own one per project. */
export const RELAY_SESSION_LIMIT = 500;
/** Stored model ids in provider/model form. */
export const RELAY_MODEL_LIMIT = 200;
/** Truncation for one stored error text. */
const ERROR_TEXT_LIMIT = 300;
/** Truncation for one stored session key. */
const SESSION_KEY_LIMIT = 1000;
/** Truncation for one stored session id. */
const SESSION_ID_LIMIT = 100;

export interface RelayRunState {
  state: 'running' | 'ok' | 'error' | 'skipped';
  messageId: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface RelayState {
  version: 2;
  watermark: number;
  processed: string[];
  threads: string[];
  /** Coding sessions keyed by thread id and project path. */
  sessions: Record<string, string>;
  projects: string[];
  discoveryRoot: string;
  /** Persisted harness model default. Empty means the harness default. */
  model?: string;
  runs: number;
  lastRun: RelayRunState | null;
}

/** Read the state file. A missing, unreadable, or unknown-version file is null. */
export function readRelayStateFile(file: string): Partial<RelayState> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RelayState>;
    if (raw.version !== RELAY_STATE_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Keep the string entries of a saved array, bounded to the newest limit. */
export function parseStringArray(value: unknown, limit?: number): string[] {
  if (!Array.isArray(value)) return [];
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return limit === undefined ? entries : entries.slice(-limit);
}

/** Keep the valid session rows, bounded for storage. */
export function parseSessions(value: unknown): Record<string, string> {
  const sessions: Record<string, string> = {};
  if (!value || typeof value !== 'object') return sessions;
  for (const [key, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === 'string' && id) sessions[key.slice(0, SESSION_KEY_LIMIT)] = id.slice(0, SESSION_ID_LIMIT);
  }
  return sessions;
}

/** Keep one bounded model id. Undefined means the harness default. */
export function parseModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, RELAY_MODEL_LIMIT) : undefined;
}

/** Validate one saved run record. */
export function parseRelayRun(value: unknown): RelayRunState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RelayRunState>;
  if (raw.state !== 'running' && raw.state !== 'ok' && raw.state !== 'error' && raw.state !== 'skipped') return null;
  if (typeof raw.messageId !== 'string' || typeof raw.startedAt !== 'number') return null;
  return {
    state: raw.state,
    messageId: raw.messageId,
    startedAt: raw.startedAt,
    endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : undefined,
    error: typeof raw.error === 'string' ? raw.error.slice(0, ERROR_TEXT_LIMIT) : undefined,
  };
}
