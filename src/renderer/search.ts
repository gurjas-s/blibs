import type { SearchFilters } from './client';

/** Vendors that a `#provider` token can select. */
export const SEARCH_PROVIDERS = ['muse', 'dots', 'grok', 'custom'] as const;

/** Persistent search defaults from the Settings screen. */
export interface SearchDefaults {
  threadId: string;
  from: string;
  to: string;
}

export const EMPTY_SEARCH_DEFAULTS: SearchDefaults = {
  threadId: '',
  from: '',
  to: '',
};

/** One search that the results pane runs. */
export interface SearchCommand {
  id: number;
  text: string;
  filters: SearchFilters;
  ask: boolean;
}

/**
 * Remove one known `#provider` token from the typed search text.
 * The token stays in the input, but it is not part of the query.
 */
export function parseSearchQuery(raw: string): { text: string; provider?: string } {
  let provider: string | undefined;
  const text = raw
    .replace(/(^|\s)#([A-Za-z]+)(?=\s|$)/g, (match, lead: string, name: string) => {
      const value = name.toLowerCase();
      if (provider || !(SEARCH_PROVIDERS as readonly string[]).includes(value)) return match;
      provider = value;
      return lead;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return provider ? { text, provider } : { text };
}

/** Build the search filters from the Settings defaults and a `#provider` token. */
export function filtersFromDefaults(
  defaults: SearchDefaults,
  provider?: string,
): SearchFilters {
  return {
    provider,
    threadId: defaults.threadId.trim() || undefined,
    from: defaults.from ? new Date(`${defaults.from}T00:00:00`).getTime() : undefined,
    to: defaults.to ? new Date(`${defaults.to}T23:59:59.999`).getTime() : undefined,
  };
}
