import type { Agent, ProviderMeta } from './types';

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'muse',
    vendor: 'Meta',
    product: 'Muse (personal agent)',
    embedUrl: 'https://muse.ai/',
    apiBase: 'https://dev.meta.ai/v1 (Model API — Muse Spark)',
    model: 'muse-spark-1.3',
    keyName: 'META_API_KEY',
    docs: 'https://dev.meta.ai/docs',
    hasChatHistoryApi: false,
    notes:
      'No public API for the consumer Muse app chat history (muse.ai / WhatsApp). Use the Meta Model API for agent capability + embed the web app for real chats.',
  },
  {
    id: 'dots',
    vendor: 'OpenAI',
    product: 'Dots (always-on agent)',
    embedUrl: 'https://chatgpt.com/',
    apiBase: 'https://api.openai.com/v1 (Responses / Chat Completions)',
    model: 'gpt-6-astra (via ChatGPT; API uses gpt-5-class)',
    keyName: 'OPENAI_API_KEY',
    docs: 'https://platform.openai.com/docs',
    hasChatHistoryApi: false,
    notes:
      'Dots launched Sep 29 2026 for Pro/Business only. No standalone Dots chat-history API — Dots live inside ChatGPT/Slack/Teams. Use OpenAI API + embed ChatGPT.',
  },
  {
    id: 'grok',
    vendor: 'xAI / SpaceXAI',
    product: 'Grok Bot (cloud-computer agent)',
    embedUrl: 'https://grok.com/',
    apiBase: 'https://api.x.ai/v1 (OpenAI-compatible)',
    model: 'grok-4.7',
    keyName: 'XAI_API_KEY',
    docs: 'https://docs.x.ai',
    hasChatHistoryApi: false,
    notes:
      'xAI API exists for Grok models (incl. multi-agent grok-4.20-multi-agent) but Grok Bot cloud-computer sessions have no public history API. Use xAI API + embed grok.com.',
  },
];

export const SEED_AGENTS: Agent[] = [
  {
    id: 'muse-1',
    name: 'Muse',
    provider: 'muse',
    vendor: 'Meta',
    description: 'Errands, shopping, scheduling, goals',
    color: '#0082fb',
    avatar: '🌀',
    status: 'embedded',
    lastActive: '2m ago',
  },
  {
    id: 'dots-1',
    name: 'Alfred',
    provider: 'dots',
    vendor: 'OpenAI',
    description: 'Always-on dot · watches repos & inbox',
    color: '#10a37f',
    avatar: '🫧',
    status: 'needs-key',
    lastActive: '14m ago',
  },
  {
    id: 'grok-1',
    name: 'Sidekick',
    provider: 'grok',
    vendor: 'xAI',
    description: 'Cloud computer · code + browser jobs',
    color: '#e5e5e5',
    avatar: '🤖',
    status: 'needs-key',
    lastActive: '1h ago',
  },
];

export const SEED_MESSAGES: Record<string, { role: 'user' | 'agent'; text: string }[]> = {
  'muse-1': [
    { role: 'user', text: 'Book tennis lessons for next week and track prices for the flight to NYC.' },
    { role: 'agent', text: 'On it — I opened a secure browser session, found 3 lesson slots near you, and I’ll keep watching the NYC fare. Approve slot B to confirm?' },
  ],
  'dots-1': [
    { role: 'user', text: 'Watch customer feedback and file a bug fix when something breaks.' },
    { role: 'agent', text: 'Dot armed 🫧 — monitoring #feedback in Slack + the repo. I’ll open a PR the moment I see a repro, and ping you before anything sensitive.' },
  ],
  'grok-1': [
    { role: 'user', text: 'Rerun the analysis when new experiment data lands.' },
    { role: 'agent', text: 'Standing by on my cloud computer. Drop the dataset link and I’ll rerun, diff results, and post screenshots when done.' },
  ],
};

export function mockReply(provider: string, input: string): string {
  const short = input.length > 90 ? input.slice(0, 90) + '…' : input;
  switch (provider) {
    case 'muse':
      return `Muse here 🌀 — got it: “${short}”. I drafted a plan (3 steps) in my secure VM and need one approval to act. (POC mock — connect META_API_KEY or open the embedded Muse tab for the real thing.)`;
    case 'dots':
      return `Dot 🫧 bubbling away: “${short}”. I’ll keep working in the background on my cloud computer and message you in ChatGPT/Slack when done. (POC mock — add OPENAI_API_KEY for live replies.)`;
    case 'grok':
      return `Grok Bot 🤖 on its cloud desktop: “${short}”. I can click around apps and run code like you would — give me credentials via a secure form and I’ll proceed. (POC mock — add XAI_API_KEY for live replies.)`;
    default:
      return `Custom agent echo: “${short}”. (POC mock.)`;
  }
}

export function providerFor(agent: Agent): ProviderMeta {
  return PROVIDERS.find((p) => p.id === agent.provider) ?? PROVIDERS[0];
}
