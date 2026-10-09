import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupMessages, mergeImports } from '../src/renderer/messages.ts';
import type { ChatMessage } from '../src/renderer/types.ts';

const agents = [{ id: 'dots', provider: 'dots' as const }];
const sent: ChatMessage = { id: 'local', agentId: 'dots', role: 'user', text: 'Hello\nworld', ts: 10, source: 'desktop', outStatus: 'queued' };

test('sync collapses a sent-message echo but keeps an agent response with identical text', () => {
  const current = { dots: [sent] };
  const next = mergeImports(current, agents, [
    { provider: 'dots', role: 'user', text: 'You: Hello world', ts: 11 },
    { provider: 'dots', role: 'agent', text: 'Hello world', ts: 12 },
  ]);
  assert.equal(next.dots.length, 2);
  assert.equal(next.dots[0], sent);
  assert.equal(next.dots[1].role, 'agent');
  assert.equal(current.dots.length, 1, 'merge does not mutate current state');
  assert.equal(mergeImports(next, agents, [{ provider: 'dots', role: 'agent', text: 'Hello world', ts: 12 }]), next);
});

test('message groups break on speaker, time gaps, and calendar dates', () => {
  const timestamp = new Date(2026, 0, 1, 23, 59).getTime();
  const messages: ChatMessage[] = [
    { ...sent, ts: timestamp }, { ...sent, id: 'second', ts: timestamp + 1000 },
    { ...sent, id: 'next-day', ts: timestamp + 61000 },
    { ...sent, id: 'reply', role: 'agent', ts: timestamp + 62000 },
    { ...sent, id: 'later', role: 'agent', ts: timestamp + 10 * 60 * 1000 },
  ];
  assert.deepEqual(groupMessages(messages).map((group) => group.length), [2, 1, 1, 1]);
});
