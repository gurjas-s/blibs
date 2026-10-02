export type ProviderId = 'muse' | 'dots' | 'grok' | 'custom';

export interface Agent {
  id: string;
  name: string;
  provider: ProviderId;
  vendor: string;
  description: string;
  site: string;
  /** epoch ms of last successful extension sync, null = never */
  lastSyncAt: number | null;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
  source: 'extension' | 'mock' | 'api' | 'embed';
  /** how a user message was delivered (vendor tab via extension, model API, or local mock) */
  via?: 'tab' | 'model' | 'mock';
  /** proxy outbox id for tab-routed messages */
  outId?: string;
  /** delivery state of a tab-routed message */
  outStatus?: 'queued' | 'sent' | 'failed';
}

export interface ProviderMeta {
  id: ProviderId;
  vendor: string;
  product: string;
  site: string;
  blurb: string;
}
