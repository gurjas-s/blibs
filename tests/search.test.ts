import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_SEARCH_DEFAULTS,
  filtersFromDefaults,
  parseSearchQuery,
} from '../src/renderer/search.ts';

test('parseSearchQuery removes one known provider token', () => {
  assert.deepEqual(parseSearchQuery('grocery'), { text: 'grocery' });
  assert.deepEqual(parseSearchQuery('#muse grocery'), { text: 'grocery', provider: 'muse' });
  assert.deepEqual(parseSearchQuery('  grocery   #DOTS '), { text: 'grocery', provider: 'dots' });
  assert.deepEqual(parseSearchQuery('#dots'), { text: '', provider: 'dots' });
  assert.deepEqual(parseSearchQuery('#nope grocery'), { text: '#nope grocery' });
  assert.deepEqual(parseSearchQuery('#muse #dots'), { text: '#dots', provider: 'muse' });
});

test('filtersFromDefaults keeps the advanced filters and the token provider', () => {
  const filters = filtersFromDefaults(
    { threadId: ' thread-1 ', from: '2026-01-02', to: '2026-01-03' },
    'grok',
  );
  assert.equal(filters.provider, 'grok');
  assert.equal(filters.threadId, 'thread-1');
  assert.equal(filters.from, new Date('2026-01-02T00:00:00').getTime());
  assert.equal(filters.to, new Date('2026-01-03T23:59:59.999').getTime());
  assert.deepEqual(filtersFromDefaults(EMPTY_SEARCH_DEFAULTS), {
    provider: undefined,
    threadId: undefined,
    from: undefined,
    to: undefined,
  });
  assert.equal(filtersFromDefaults(EMPTY_SEARCH_DEFAULTS, 'custom').provider, 'custom');
});
