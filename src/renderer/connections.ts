/**
 * Connection state for the connector model.
 *
 * blibs connects personal assistants to local coding harnesses. This module
 * owns the typed state, the derivation from the desktop login status, and the
 * local persistence. Components get the state through props and report changes
 * through callbacks. A later backend task replaces the storage seam.
 */
import type { HarnessActionStatus, HarnessId, LoginStatus } from './types';

/** One local coding harness that an assistant can use. */
export interface HarnessMeta {
  id: HarnessId;
  name: string;
}

/** Harnesses in display order. */
export const HARNESSES: HarnessMeta[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
];

/** The folder that the harnesses share with the assistants. */
export const DEFAULT_SHARED_FOLDER = '~/Projects';

/** Local storage key for the connection state. */
export const CONNECTIONS_STORAGE_KEY = 'blibs-connections-v1';

/** True when an assistant is signed in and ready to chat. */
export type AssistantSetup = 'connected' | 'setup';

export interface AssistantConnection {
  /** Enabled harnesses for this assistant. */
  harnesses: Record<HarnessId, boolean>;
  /** Last known setup state. The login status can override it. */
  setup: AssistantSetup;
}

/** One summary of harness work. The chat and the context column show it. */
export interface ActionSummary {
  id: string;
  assistantId: string;
  harness: HarnessId;
  title: string;
  detail: string;
  status: HarnessActionStatus;
  /** Time of the summary in epoch milliseconds. */
  at: number;
}

export interface ConnectionState {
  folder: string;
  /** Connection records, keyed by agent id. */
  assistants: Record<string, AssistantConnection>;
  /** Newest first when read. The app holds an empty list until a backend reports work. */
  activity: ActionSummary[];
}

/** The storage operations that this module needs. */
export type ConnectionStorage = Pick<Storage, 'getItem' | 'setItem'>;

const STATUSES: HarnessActionStatus[] = ['completed', 'running', 'failed'];

function defaultHarnesses(): Record<HarnessId, boolean> {
  return {
    'claude-code': true,
    codex: true,
    opencode: true,
  };
}

/** Build the default state for a list of assistants. */
export function createConnectionState(assistantIds: readonly string[]): ConnectionState {
  const assistants: Record<string, AssistantConnection> = {};
  for (const id of assistantIds) {
    assistants[id] = { harnesses: defaultHarnesses(), setup: 'setup' };
  }
  return { folder: DEFAULT_SHARED_FOLDER, assistants, activity: [] };
}

/** Return the record for one assistant, with defaults when it is missing. */
export function connectionFor(state: ConnectionState, assistantId: string): AssistantConnection {
  return state.assistants[assistantId] ?? { harnesses: defaultHarnesses(), setup: 'setup' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHarnessId(value: unknown): value is HarnessId {
  return HARNESSES.some((harness) => harness.id === value);
}

function normalizeHarnesses(value: unknown): Record<HarnessId, boolean> {
  const raw = isRecord(value) ? value : {};
  const harnesses = defaultHarnesses();
  for (const harness of HARNESSES) {
    const enabled = raw[harness.id];
    if (typeof enabled === 'boolean') harnesses[harness.id] = enabled;
  }
  return harnesses;
}

function normalizeAssistant(value: unknown): AssistantConnection {
  const raw = isRecord(value) ? value : {};
  return {
    harnesses: normalizeHarnesses(raw.harnesses),
    setup: raw.setup === 'connected' ? 'connected' : 'setup',
  };
}

function normalizeAction(value: unknown): ActionSummary | null {
  if (!isRecord(value)) return null;
  const { id, assistantId, title, detail, at } = value;
  if (typeof id !== 'string' || !id) return null;
  if (typeof assistantId !== 'string' || !assistantId) return null;
  if (typeof title !== 'string' || !title) return null;
  if (typeof detail !== 'string') return null;
  if (!isHarnessId(value.harness)) return null;
  if (!STATUSES.includes(value.status as HarnessActionStatus)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return {
    id,
    assistantId,
    harness: value.harness,
    title,
    detail,
    status: value.status as HarnessActionStatus,
    at,
  };
}

/** Read the saved state. Bad or partial data falls back to safe defaults. */
export function readConnectionState(
  assistantIds: readonly string[],
  storage: ConnectionStorage = localStorage,
): ConnectionState {
  const fallback = createConnectionState(assistantIds);
  let parsed: unknown;
  try {
    const raw = storage.getItem(CONNECTIONS_STORAGE_KEY);
    if (!raw) return fallback;
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;

  const assistants: Record<string, AssistantConnection> = {};
  const saved = isRecord(parsed.assistants) ? parsed.assistants : {};
  for (const id of assistantIds) {
    assistants[id] = normalizeAssistant(saved[id]);
  }

  const activity = Array.isArray(parsed.activity)
    ? parsed.activity.map(normalizeAction).filter((item): item is ActionSummary => item !== null)
    : [];

  return {
    folder: typeof parsed.folder === 'string' && parsed.folder.trim()
      ? parsed.folder.trim()
      : DEFAULT_SHARED_FOLDER,
    assistants,
    activity: activity.sort((a, b) => b.at - a.at),
  };
}

/** Save the state. A full store or a blocked storage keeps the window usable. */
export function writeConnectionState(
  state: ConnectionState,
  storage: ConnectionStorage = localStorage,
): void {
  try {
    storage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The choice still applies for this window.
  }
}

/** Enable or disable one harness for one assistant. */
export function setHarnessEnabled(
  state: ConnectionState,
  assistantId: string,
  harnessId: HarnessId,
  enabled: boolean,
): ConnectionState {
  const current = connectionFor(state, assistantId);
  if (current.harnesses[harnessId] === enabled) return state;
  return {
    ...state,
    assistants: {
      ...state.assistants,
      [assistantId]: {
        ...current,
        harnesses: { ...current.harnesses, [harnessId]: enabled },
      },
    },
  };
}

/** Set the shared folder for harness work. */
export function setSharedFolder(state: ConnectionState, folder: string): ConnectionState {
  const next = folder.trim();
  if (!next || next === state.folder) return state;
  return { ...state, folder: next };
}

/** Set the persisted setup state for one assistant. */
export function setAssistantSetup(
  state: ConnectionState,
  assistantId: string,
  setup: AssistantSetup,
): ConnectionState {
  const current = connectionFor(state, assistantId);
  if (current.setup === setup) return state;
  return {
    ...state,
    assistants: {
      ...state.assistants,
      [assistantId]: { ...current, setup },
    },
  };
}

/**
 * Derive the setup state from the desktop login status when a status exists.
 * A signed-in session is connected. An unfinished attempt is setup. A status
 * that is still opening or loading is not an answer, so the saved state wins.
 */
export function resolveSetupStatus(
  connection: AssistantConnection,
  status: LoginStatus | undefined,
): AssistantSetup {
  if (status?.phase === 'signed-in') return 'connected';
  if (status && status.phase !== 'closed' && status.phase !== 'opening' && status.phase !== 'loading') {
    return 'setup';
  }
  return connection.setup;
}

/** The link that the user pastes into an assistant connector. */
export function connectLinkFor(assistantId: string): string {
  return `https://blibs.app/c/${encodeURIComponent(assistantId)}`;
}

/** Recent activity for one assistant, newest first. */
export function actionsFor(state: ConnectionState, assistantId: string): ActionSummary[] {
  return state.activity
    .filter((action) => action.assistantId === assistantId)
    .sort((a, b) => b.at - a.at);
}

/** The newest activity for one assistant, or undefined when none exists. */
export function latestAction(
  state: ConnectionState,
  assistantId: string,
): ActionSummary | undefined {
  return actionsFor(state, assistantId)[0];
}

/** Display name for one harness id. */
export function harnessName(harnessId: HarnessId): string {
  return HARNESSES.find((harness) => harness.id === harnessId)?.name ?? harnessId;
}
