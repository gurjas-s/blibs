import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONNECTIONS_STORAGE_KEY,
  DEFAULT_SHARED_FOLDER,
  HARNESSES,
  actionsFor,
  connectLinkFor,
  connectionFor,
  createConnectionState,
  latestAction,
  readConnectionState,
  resolveSetupStatus,
  setAssistantSetup,
  setHarnessEnabled,
  setSharedFolder,
  writeConnectionState,
} from '../src/renderer/connections.ts';
import type { ActionSummary, ConnectionState } from '../src/renderer/connections.ts';

class MemoryStorage {
  private items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const IDS = ['muse', 'dots', 'grok'];

function action(overrides: Partial<ActionSummary> = {}): ActionSummary {
  return {
    id: 'action-1',
    assistantId: 'muse',
    harness: 'claude-code',
    title: 'Fixed the login button',
    detail: 'Updated the handler and ran the tests.',
    status: 'completed',
    at: 1_000,
    ...overrides,
  };
}

test('createConnectionState enables every harness and starts in setup', () => {
  const state = createConnectionState(IDS);
  assert.equal(state.folder, DEFAULT_SHARED_FOLDER);
  assert.deepEqual(state.activity, []);
  for (const id of IDS) {
    assert.equal(state.assistants[id].setup, 'setup');
    for (const harness of HARNESSES) {
      assert.equal(state.assistants[id].harnesses[harness.id], true);
    }
  }
});

test('setHarnessEnabled changes one cell and keeps the other state', () => {
  const state = createConnectionState(IDS);
  const next = setHarnessEnabled(state, 'muse', 'codex', false);

  assert.notEqual(next, state);
  assert.equal(next.assistants.muse.harnesses.codex, false);
  assert.equal(next.assistants.muse.harnesses['claude-code'], true);
  assert.equal(next.assistants.dots.harnesses.codex, true);
  assert.equal(setHarnessEnabled(next, 'muse', 'codex', false), next);
});

test('setSharedFolder trims the path and rejects an empty value', () => {
  const state = createConnectionState(IDS);
  assert.equal(setSharedFolder(state, '  '), state);
  assert.equal(setSharedFolder(state, ' ~/Work ').folder, '~/Work');
});

test('setAssistantSetup returns the same state when nothing changes', () => {
  const state = createConnectionState(IDS);
  assert.equal(setAssistantSetup(state, 'muse', 'setup'), state);
  assert.equal(setAssistantSetup(state, 'muse', 'connected').assistants.muse.setup, 'connected');
});

test('resolveSetupStatus uses the desktop login status when it exists', () => {
  const state = createConnectionState(IDS);
  const connected = setAssistantSetup(state, 'muse', 'connected');

  assert.equal(
    resolveSetupStatus(connectionFor(connected, 'muse'), {
      vendorId: 'muse',
      phase: 'signed-in',
      message: '',
      mock: true,
    }),
    'connected',
  );
  assert.equal(
    resolveSetupStatus(connectionFor(connected, 'muse'), {
      vendorId: 'muse',
      phase: 'needs-verification',
      message: '',
      mock: true,
    }),
    'setup',
  );
  assert.equal(
    resolveSetupStatus(connectionFor(connected, 'muse'), {
      vendorId: 'muse',
      phase: 'closed',
      message: '',
      mock: true,
    }),
    'connected',
    'A closed attempt must not clear a connected session.',
  );
  assert.equal(resolveSetupStatus(connectionFor(connected, 'muse'), undefined), 'connected');
});

test('writeConnectionState and readConnectionState round-trip the state', () => {
  const storage = new MemoryStorage();
  const state = setAssistantSetup(
    setHarnessEnabled(createConnectionState(IDS), 'muse', 'claude-code', false),
    'dots',
    'connected',
  );
  const withFolder = setSharedFolder(state, '~/Work');
  const full: ConnectionState = {
    ...withFolder,
    activity: [action({ at: 2_000 }), action({ id: 'action-0', at: 1_000, status: 'running' })],
  };

  writeConnectionState(full, storage);
  assert.ok(storage.getItem(CONNECTIONS_STORAGE_KEY));

  const read = readConnectionState(IDS, storage);
  assert.equal(read.folder, '~/Work');
  assert.equal(read.assistants.muse.harnesses['claude-code'], false);
  assert.equal(read.assistants.dots.setup, 'connected');
  assert.deepEqual(read.activity.map((item) => item.id), ['action-1', 'action-0']);
});

test('readConnectionState repairs bad data instead of throwing', () => {
  const storage = new MemoryStorage();
  storage.setItem(CONNECTIONS_STORAGE_KEY, '{not json');
  assert.deepEqual(readConnectionState(IDS, storage), createConnectionState(IDS));

  storage.setItem(
    CONNECTIONS_STORAGE_KEY,
    JSON.stringify({
      folder: '  ',
      assistants: {
        muse: { harnesses: { codex: 'yes', unknown: false }, setup: 'other' },
        extra: { setup: 'connected' },
      },
      activity: [
        action({ harness: 'missing-harness' }),
        action({ id: 'kept', harness: 'codex' }),
        { id: 'broken' },
      ],
    }),
  );

  const read = readConnectionState(IDS, storage);
  assert.equal(read.folder, DEFAULT_SHARED_FOLDER);
  assert.equal(read.assistants.muse.harnesses.codex, true);
  assert.equal(read.assistants.muse.setup, 'setup');
  assert.equal(read.assistants.extra, undefined, 'Unknown assistants are not invented.');
  assert.equal(read.assistants.grok.harnesses.opencode, true);
  assert.deepEqual(read.activity.map((item) => item.id), ['kept']);
});

test('activity is filtered per assistant and sorted newest first', () => {
  const state: ConnectionState = {
    ...createConnectionState(IDS),
    activity: [
      action({ id: 'old', at: 1_000 }),
      action({ id: 'new', at: 3_000 }),
      action({ id: 'dots', assistantId: 'dots', at: 2_000 }),
    ],
  };

  assert.deepEqual(actionsFor(state, 'muse').map((item) => item.id), ['new', 'old']);
  assert.equal(latestAction(state, 'muse')?.id, 'new');
  assert.equal(latestAction(state, 'grok'), undefined);
});

test('connectLinkFor puts the assistant id in the link', () => {
  assert.equal(connectLinkFor('grok'), 'https://blibs.app/c/grok');
});
