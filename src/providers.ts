import type { Agent, ProviderMeta } from './types';

/** The three real personal-agent products. Names are the vendors' own. */
export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'muse',
    vendor: 'Meta',
    product: 'Muse',
    site: 'https://muse.ai/',
    blurb: 'Personal agent for errands, shopping and scheduling',
  },
  {
    id: 'dots',
    vendor: 'OpenAI',
    product: 'Dots',
    site: 'https://chatgpt.com/',
    blurb: 'Always-on agents inside ChatGPT',
  },
  {
    id: 'grok',
    vendor: 'xAI',
    product: 'Grok',
    site: 'https://grok.com/',
    blurb: 'Agents on a cloud computer',
  },
];

export const SEED_AGENTS: Agent[] = PROVIDERS.map((p) => ({
  id: p.id,
  name: p.product,
  provider: p.id,
  vendor: p.vendor,
  description: p.blurb,
  site: p.site,
  lastSyncAt: null,
}));

export function providerFor(agent: Agent): ProviderMeta {
  return PROVIDERS.find((p) => p.id === agent.provider) ?? PROVIDERS[0];
}
