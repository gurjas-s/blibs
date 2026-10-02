export type ProviderId = 'muse' | 'dots' | 'grok' | 'custom';

export interface Agent {
  id: string;
  name: string;
  provider: ProviderId;
  vendor: string;
  description: string;
  color: string;
  avatar: string; // emoji for POC
  status: 'online' | 'idle' | 'needs-key' | 'embedded';
  lastActive: string;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: number;
  source: 'mock' | 'api' | 'embed' | 'extension';
}

export interface ProviderMeta {
  id: ProviderId;
  vendor: string;
  product: string;
  embedUrl: string;
  apiBase: string;
  model: string;
  keyName: string;
  docs: string;
  hasChatHistoryApi: boolean;
  notes: string;
}
