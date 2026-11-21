/**
 * The single typed data client for the renderer.
 *
 * Components stay pure and get data through props. App code in this folder
 * calls these functions. Do not call `fetch` from a component.
 */
import type { ChatMessage } from './types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** One chat record that a vendor session pushed to the backend. */
export interface ImportItem {
  id: string;
  provider: string;
  role: string;
  text: string;
  ts: number;
}

/** One delivery record from the send outbox. */
export interface OutboxItem {
  id: string;
  status: ChatMessage['outStatus'];
}

/** Retained history message returned by the history routes. */
export interface HistoryMessage {
  id: string;
  provider: string;
  threadId: string;
  role: string;
  text: string;
  ts: number;
  url: string;
  identity: string;
}

/** Search hit with its matched snippet and optional nearby messages. */
export interface SearchResult extends HistoryMessage {
  snippet: string;
  context?: HistoryMessage[];
}

/** One quoted claim in a local answer. */
export interface Claim {
  text: string;
  sourceId: string;
  quote: string;
}

/** Status of the local search index. */
export interface IndexStatus {
  total: number;
  indexed: number;
  running: boolean;
  paused: boolean;
  embeddingConfigured: boolean;
  generationConfigured: boolean;
  error?: string;
  migrationWarning?: string;
}

/** Result of a keyword or hybrid search. */
export interface SearchResponse {
  results?: SearchResult[];
  sources?: SearchResult[];
  claims?: Claim[];
  answer?: string;
  abstained?: boolean;
  reason?: string;
  warning?: string;
  hasMore?: boolean;
  latencyMs?: number;
  mode?: string;
}

/** Search filters. Omit a filter to leave it open. */
export interface SearchFilters {
  provider?: string;
  threadId?: string;
  from?: number;
  to?: number;
}

export interface SearchRequest {
  query: string;
  offset: number;
  filters: SearchFilters;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data
      ? String((data as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

/** Pull the latest vendor chat imports. */
export async function fetchImports(signal?: AbortSignal): Promise<ImportItem[]> {
  const data = await request<{ imports?: ImportItem[] }>('/api/imports', { signal });
  return data.imports ?? [];
}

/** Read the delivery state for every outbox item. */
export async function fetchOutboxStatuses(): Promise<Map<string, string>> {
  const data = await request<{ items?: OutboxItem[] }>('/api/outbox');
  return new Map((data.items ?? []).map((item) => [item.id, String(item.status)]));
}

/** Queue a reply for the matching vendor session and return its outbox id. */
export async function queueOutbox(provider: string, text: string): Promise<string> {
  const data = await request<{ id?: string; error?: string }>('/api/outbox', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ provider, text }),
  });
  if (!data.id) throw new Error(data.error ?? 'The backend did not return an outbox id.');
  return data.id;
}

/** Put a failed outbox item back in the queue. */
export async function retryOutbox(id: string): Promise<void> {
  await request<unknown>('/api/outbox/retry', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id }),
  });
}

/** Read the current local index state. */
export function fetchIndexStatus(signal?: AbortSignal): Promise<IndexStatus> {
  return request<IndexStatus>('/api/index', { signal });
}

/** Resume, cancel, or rebuild the local index. */
export function updateIndex(action: 'resume' | 'cancel' | 'rebuild'): Promise<IndexStatus> {
  return request<IndexStatus>('/api/index', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ action }),
  });
}

/** Run a keyword or hybrid search over retained history. */
export function searchConversations(body: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  return request<SearchResponse>('/api/search', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal,
  });
}

/** Run the experimental local answer path over retained history. */
export function askConversations(body: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  return request<SearchResponse>('/api/ask', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal,
  });
}

/** Load one exact retained history message. */
export async function fetchHistoryItem(id: string): Promise<HistoryMessage> {
  const data = await request<{ item: HistoryMessage }>(`/api/history/${encodeURIComponent(id)}`);
  return data.item;
}

/** Harness defaults and the projects directory behind a relay run. */
export interface RelayStatus {
  enabled: boolean;
  provider: string;
  harness: { id: string; command: string; cwd: string; model?: string };
  /** Harness rows that the introduction reply lists. */
  harnesses: Array<{ id: string; name: string; enabled: boolean }>;
  discoveryRoot: string;
  projects: Array<{ name: string; token: string }>;
  pending: number;
  sessions: number;
}

/** Read the relay harness defaults and the projects directory. */
export function fetchRelayStatus(signal?: AbortSignal): Promise<RelayStatus> {
  return request<RelayStatus>('/api/relay', { signal });
}

/** Save the harness setting for the configured relay assistant. */
export function updateRelayHarnesses(
  harnesses: Array<{ id: string; name: string; enabled: boolean }>,
): Promise<RelayStatus> {
  return request<RelayStatus>('/api/relay/harnesses', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ harnesses }),
  });
}

/** Set the projects directory and relay model. Omit a field to keep its value. */
export function updateRelayProjects(
  body: { discoveryRoot?: string; model?: string | null },
): Promise<RelayStatus> {
  return request<RelayStatus>('/api/relay/projects', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}


export function createRelayProject(name: string): Promise<{ token: string; relay: RelayStatus }> {
  return request('/api/relay/projects/create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}
