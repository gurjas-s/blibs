import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectedProviders, firstSyncedAgent, onboardingScreen, readOnboarding } from '../src/renderer/onboarding-state.ts';
import { SEED_AGENTS } from '../src/renderer/providers.ts';
import type { ChatMessage } from '../src/renderer/types.ts';

test('first run starts at welcome; saved progress and completion survive reload', () => {
  assert.equal(readOnboarding(null).step, 'welcome');
  assert.equal(readOnboarding({ step: 'invalid', providers: [] }).step, 'welcome');
  const progress = { step: 'sync', providers: ['dots', 'unknown'] };
  assert.deepEqual(readOnboarding(JSON.parse(JSON.stringify(progress))), { step: 'sync', providers: ['dots'] });
  assert.equal(readOnboarding({ step: 'complete', providers: [] }).step, 'complete');
});

test('only signed-in agents count as connected', () => {
  const sessions = ['ready', 'signed-out', 'error'].map((state, index) => ({
    provider: SEED_AGENTS[index].provider, state: state as 'ready' | 'signed-out' | 'error', reason: '', updatedAt: 1, lastSyncAt: null,
  }));
  assert.deepEqual(connectedProviders(sessions), ['muse']);
});

test('setup finishes after an imported chat for a selected agent, not a queued local message', () => {
  const progress = { step: 'sync' as const, providers: ['dots'] };
  const message: ChatMessage = { id: 'test', agentId: 'dots', role: 'user', text: 'Hello', ts: 1, source: 'desktop', via: 'tab', outStatus: 'queued' };
  assert.equal(onboardingScreen(progress, SEED_AGENTS, { dots: [message] }), 'sync');
  assert.equal(onboardingScreen(progress, SEED_AGENTS, { muse: [{ ...message, via: undefined }] }), 'sync');
  const messages = { dots: [{ ...message, via: undefined }] };
  assert.equal(onboardingScreen(progress, SEED_AGENTS, messages), 'done');
  assert.equal(firstSyncedAgent(progress, SEED_AGENTS, messages)?.name, 'Dots');
});
