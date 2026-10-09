export type ProviderId = 'muse' | 'dots' | 'grok' | 'custom';

export interface Agent {
  id: string;
  name: string;
  provider: ProviderId;
  vendor: string;
  description: string;
  site: string;
  /** epoch ms of last successful desktop sync, null = never */
  lastSyncAt: number | null;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
  source: 'desktop' | 'extension' | 'mock' | 'api' | 'embed';
  /** how a user message was delivered (vendor session in the app, model API, or local mock) */
  via?: 'tab' | 'model' | 'mock';
  /** proxy outbox id for session-routed messages */
  outId?: string;
  /** delivery state of a session-routed message */
  outStatus?: 'queued' | 'sent' | 'failed';
}

export interface ProviderMeta {
  id: ProviderId;
  vendor: string;
  product: string;
  site: string;
  blurb: string;
}

export type { VendorSession } from '../preload/agent';
declare global {
  interface Window {
    blibs?: {
      sessions(): Promise<import('../preload/agent').VendorSession[]>;
      signIn(provider: string): Promise<{ ok: boolean }>;
    };
  }
}
