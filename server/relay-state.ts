// On-disk relay state.
//
// The relay service and the router MCP server read the same state file. This
// module owns the file shape, its limits, and its parsers, so both processes
// agree on the data.
import fs from 'node:fs';
import type { HarnessChoice } from './harness/intro.js';

export const RELAY_STATE_VERSION = 2;
export const RELAY_PROCESSED_LIMIT = 500;
export const RELAY_THREAD_LIMIT = 500;
/** Harness rows that the panel can report. */
export const RELAY_HARNESS_LIMIT = 20;
/** Length limit for one reported harness id or name. */
export const HARNESS_TEXT_LIMIT = 60;
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
  /** Session id of the routing agent. One routing agent serves every thread. */
  routerSessionId?: string;
  projects: string[];
  discoveryRoot: string;
  /** Persisted harness model default. Empty means the harness default. */
  model?: string;
  /** Harness rows that the panel last reported. Empty means the build default. */
  harnesses: HarnessChoice[];
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

/** Keep one bounded session id. Undefined means no session yet. */
export function parseSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, SESSION_ID_LIMIT) : undefined;
}

/** Keep one bounded model id. Undefined means the harness default. */
export function parseModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, RELAY_MODEL_LIMIT) : undefined;
}

/** Keep valid harness rows that the panel reported, bounded for storage. */
export function parseHarnesses(value: unknown): HarnessChoice[] {
  if (!Array.isArray(value)) return [];
  const harnesses: HarnessChoice[] = [];
  for (const entry of value.slice(0, RELAY_HARNESS_LIMIT)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<HarnessChoice>;
    if (typeof raw.id !== 'string' || !raw.id.trim()) continue;
    if (typeof raw.name !== 'string' || !raw.name.trim()) continue;
    harnesses.push({
      id: raw.id.trim().slice(0, HARNESS_TEXT_LIMIT),
      name: raw.name.trim().slice(0, HARNESS_TEXT_LIMIT),
      enabled: raw.enabled === true,
    });
  }
  return harnesses;
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
