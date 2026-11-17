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
  historyId?: string;
}

export interface ProviderMeta {
  id: ProviderId;
  vendor: string;
  product: string;
  site: string;
  blurb: string;
}

export type LoginPhase =
  | 'opening'
  | 'loading'
  | 'needs-sign-in'
  | 'needs-verification'
  | 'needs-captcha'
  | 'signed-in'
  | 'error'
  | 'closed';

/** One sign-in step reported by the main process. */
export interface LoginStatus {
  vendorId: string;
  phase: LoginPhase;
  message: string;
  mock: boolean;
}

export interface DesktopLoginApi {
  open: (vendorId: string) => Promise<LoginStatus>;
  cancel: (vendorId: string) => Promise<LoginStatus>;
  check: (vendorId: string) => Promise<LoginStatus>;
  status: (vendorId: string) => Promise<LoginStatus | null>;
  onStatus: (listener: (status: LoginStatus) => void) => () => void;
}

declare global {
  interface Window {
    /** Narrow bridge from the panel preload. Browser-only builds have no bridge. */
    blibsDesktop?: { login: DesktopLoginApi };
  }
}
