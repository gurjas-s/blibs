// Relay tests use a fake harness, temporary stores, and mocked rows.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createProxyServer } from '../server/proxy.ts';
import { HistoryStore } from '../server/history.ts';
import { splitCommand } from '../server/harness/opencode.ts';
import { buildRelayConfig, isConversationThread, isProviderThread, newSessionId } from '../server/relay.ts';
import {
  clarificationText,
  findExplicitPath,
  isAllowedProject,
  listCandidates,
  resolveProject,
  sessionKey,
  threadProjects,
} from '../server/harness/router.ts';
import { extractMentionTask, sanitizeReply } from '../server/harness/mention.ts';

const FAKE_HARNESS = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const prompt = args.at(-1) || '';
fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify({ pid: process.pid, prompt, args, cwd: process.cwd(), pwd: process.env.PWD || '' }) + '\\n');
if (prompt.includes('FAIL_HARNESS')) {
  console.error('fake harness failed');
  process.exit(3);
}
if (prompt.includes('SLOW_HARNESS')) {
  setTimeout(() => process.exit(9), 10000);
} else {
  const lastLine = prompt.split('\\n').at(-1) || '';
  process.stdout.write('harness reply: ' + lastLine.slice(0, 60) + '\\n');
}
`;

interface RelayServer {
  base: string;
  dataDir: string;
  harnessDir: string;
  close: () => Promise<void>;
}

interface RelayStatus {
  enabled: boolean;
  provider: string;
  harness: { command: string; cwd: string; timeoutMs: number };
  pending: number;
  running: boolean;
  processed: number;
  watermark: number;
  sessions: number;
  lastRun: { state: string; startedAt: number; endedAt?: number; error?: string } | null;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startRelay(options: { dataDir?: string; timeoutMs?: number; model?: string; removeDataOnClose?: boolean } = {}): Promise<RelayServer> {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), 'blibs-relay-'));
  const harnessDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-harness-'));
  const fake = path.join(harnessDir, 'fake-harness.mjs');
  writeFileSync(fake, FAKE_HARNESS);
  // A real conversation already has rows, so seed one before the relay starts.
  const seed = new HistoryStore(dataDir);
  seed.import([{ provider: 'muse', role: 'user', text: 'Earlier user message.', ts: 1, url: 'https://muse.ai/chat/relay-test', sourceId: 'seed-user', identity: 'source-id' }]);
  seed.close();
  const server = createProxyServer(dataDir, {}, {
    relay: {
      enabled: true,
      provider: 'muse',
      command: JSON.stringify([process.execPath, fake]),
      cwd: harnessDir,
      timeoutMs: options.timeoutMs ?? 5000,
      ...(options.model ? { model: options.model } : {}),
    },
  });  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(harnessDir, { recursive: true, force: true });
    if (options.removeDataOnClose !== false) rmSync(dataDir, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { base, dataDir, harnessDir, close };
}

function readRuns(server: RelayServer): Array<{ pid: number; prompt: string; args: string[]; cwd: string; pwd: string }> {
  try {
    return readFileSync(path.join(server.harnessDir, 'runs.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; prompt: string; args: string[]; cwd: string; pwd: string });
  } catch {
    return [];
  }
}

function sessionOf(run: { args: string[] }): string | undefined {
  const index = run.args.indexOf('--session');
  return index === -1 ? undefined : run.args[index + 1];
}

function modelOf(run: { args: string[] }): string | undefined {
  const index = run.args.indexOf('--model');
  return index === -1 ? undefined : run.args[index + 1];
}

async function statusOf(server: RelayServer): Promise<RelayStatus> {
  return fetch(`${server.base}/api/relay`).then((response) => response.json() as Promise<RelayStatus>);
}

async function outboxOf(server: RelayServer): Promise<{ items: Array<{ provider: string; text: string; status: string; threadId?: string }> }> {
  return fetch(`${server.base}/api/outbox`).then((response) => response.json() as Promise<{ items: Array<{ provider: string; text: string; status: string; threadId?: string }> }>);
}

async function importItems(server: RelayServer, items: unknown[]): Promise<{ added: number; updated: number }> {
  const response = await fetch(`${server.base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  return response.json() as Promise<{ added: number; updated: number }>;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a relay run');
    await sleep(50);
  }
}

function museMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'muse',
    role: 'agent',
    text: '@opencode Summarize the release notes.',
    ts: Date.now() + 5000,
    url: 'https://muse.ai/chat/relay-test',
    sourceId: `relay-${Math.random().toString(36).slice(2)}`,
    identity: 'source-id',
    ...overrides,
  };
}

test('a user @opencode message starts one run and queues one Muse outbox item', async () => {
  const server = await startRelay();
  const ts = Date.now() + 5000;
  const report = await importItems(server, [museMessage({ role: 'user', text: '@opencode Summarize the release notes.', ts, sourceId: 'user-1' })]);
  assert.equal(report.added, 1);

  const status = await waitFor(async () => {
    const current = await statusOf(server);
    return current.lastRun?.state === 'ok' ? current : undefined;
  });
  assert.equal(status.enabled, true);
  assert.equal(status.provider, 'muse');
  assert.equal(status.pending, 0);
  assert.equal(status.running, false);
  assert.ok(status.lastRun?.startedAt);
  assert.ok(status.lastRun?.endedAt);

  const runs = readRuns(server);
  assert.equal(runs.length, 1);
  assert.match(runs[0].prompt, /Summarize the release notes\./);
  assert.ok(!runs[0].prompt.includes('@opencode'), 'the harness prompt has no mention token');
  assert.ok(!runs[0].args.includes('--model'), 'no model flag without a configured model');
  assert.ok(sessionOf(runs[0]), 'the run carries a session id');
  assert.equal(runs[0].cwd, realpathSync(server.harnessDir), 'the harness runs in its own directory');
  assert.equal(runs[0].pwd, server.harnessDir, 'the harness PWD matches its directory');

  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1);
  assert.equal(outbox.items[0].provider, 'muse');
  assert.equal(outbox.items[0].text, 'harness reply: Summarize the release notes.');
  assert.equal(outbox.items[0].threadId, 'https://muse.ai/chat/relay-test');

  const blocked = await fetch(`${server.base}/api/relay`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(blocked.status, 403);
});

test('a Muse @opencode delegation starts a run', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: '@opencode Fix the build.', ts: Date.now() + 5000, sourceId: 'agent-delegate' })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 1);
  assert.match(runs[0].prompt, /Fix the build\./);
});

test('a message without a mention does not start a run', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: 'Summarize the release notes with no mention.', ts: Date.now() + 5000, sourceId: 'agent-plain' })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await outboxOf(server)).items.length, 0);
  assert.equal((await statusOf(server)).lastRun, null);
});

test('a user message without a mention does not start a run', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ role: 'user', text: 'Please send this to the agent.', sourceId: 'user-1' })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await outboxOf(server)).items.length, 0);
  assert.equal((await statusOf(server)).lastRun, null);
});

test('a landing-page scrape does not start a run', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: 'How We Built Safety Into Muse', url: 'https://muse.ai/', sourceId: 'landing-1' })]);
  await sleep(300);
  // The first batch is baseline. A later landing-page scrape has no user turn.
  await importItems(server, [museMessage({ text: 'How We Designed Muse', url: 'https://muse.ai/', sourceId: 'landing-2' })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await outboxOf(server)).items.length, 0);
});

test('a root-path conversation with a user turn can relay', async () => {
  const server = await startRelay();
  const url = 'https://muse.ai/';
  const echoTs = Date.now() + 5000;
  // Muse reports the user turn with role agent and a "You:" label.
  await importItems(server, [museMessage({ role: 'agent', text: 'You:\n\nWhat is on my plate today?', url, sourceId: 'user-echo', ts: echoTs })]);
  await sleep(300);
  assert.equal(readRuns(server).length, 0, 'the user turn without a mention does not start a run');
  await importItems(server, [
    museMessage({ role: 'agent', text: '9:57 PM', url, sourceId: 'time-label', ts: echoTs + 1000 }),
    museMessage({ text: 'You:\n\n@opencode What is on my plate today?', url, sourceId: 'user-mention', ts: echoTs + 1000 }),
  ]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(readRuns(server).length, 1);
  assert.match(readRuns(server)[0].prompt, /What is on my plate today\?/);

  // The reply typed back into Muse is also a "You:" echo. It must not run.
  await importItems(server, [museMessage({ role: 'agent', text: 'You:\n\nharness reply', url, sourceId: 'reply-echo', ts: echoTs + 2000 })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 1);
});

test('a configured model reaches the harness command', async () => {
  const server = await startRelay({ model: 'test-provider/test-model' });
  await importItems(server, [museMessage({ role: 'user', text: '@opencode Summarize the model run.', ts: Date.now() + 5000, sourceId: 'model-1' })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 1);
  assert.equal(modelOf(runs[0]), 'test-provider/test-model');
  assert.equal(runs[0].cwd, realpathSync(server.harnessDir), 'the model flag does not change the directory');
});

test('one Muse thread can own one session per project', () => {
  const sessions: Record<string, string> = {};
  sessions[sessionKey('thread-a', '/projects/alpha')] = 'ses_alpha';
  sessions[sessionKey('thread-a', '/projects/beta')] = 'ses_beta';
  sessions[sessionKey('thread-b', '/projects/alpha')] = 'ses_other';
  assert.deepEqual(threadProjects(sessions, 'thread-a'), ['/projects/alpha', '/projects/beta']);
  assert.deepEqual(threadProjects(sessions, 'thread-b'), ['/projects/alpha']);
  assert.deepEqual(threadProjects(sessions, 'thread-unknown'), []);
  assert.notEqual(sessionKey('t', '/a'), sessionKey('t', '/b'), 'projects get distinct keys');
  assert.notEqual(sessionKey('t', '/a'), sessionKey('o', '/a'), 'threads get distinct keys');
});

test('the project router picks explicit paths, names, and thread memory', () => {
  const candidates = ['/projects/alpha', '/projects/beta'];
  const roots = ['/projects'];
  assert.equal(
    resolveProject('Fix the build in /projects/alpha today', [], candidates, roots)?.projectPath,
    '/projects/alpha',
  );
  assert.equal(
    resolveProject('Fix the beta flake', [], candidates, roots)?.projectPath,
    '/projects/beta',
  );
  assert.equal(resolveProject('Sync alpha and beta', [], candidates, roots), null, 'two name hits need a question');
  assert.equal(
    resolveProject('Do more work', ['/projects/alpha', '/projects/beta'], candidates, roots)?.confidence,
    'map-hit',
  );
  assert.equal(
    resolveProject('Do more work', ['/projects/alpha', '/projects/beta'], candidates, roots)?.projectPath,
    '/projects/beta',
  );
  assert.equal(resolveProject('Do work', [], [], []), null, 'no registry means the relay falls back');
  assert.equal(resolveProject('Fix it in /elsewhere/gamma', [], candidates, roots), null, 'outside roots need a question');
  assert.equal(resolveProject('Do work', [], ['/only/project'], ['/'])?.projectPath, '/only/project');
});

test('the project allowlist and candidate listing stay bounded', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'blibs-router-'));
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  mkdirSync(alpha);
  mkdirSync(beta);
  mkdirSync(path.join(root, '.hidden'));
  writeFileSync(path.join(root, 'notes.txt'), 'not a project');
  const registry = { projects: [alpha], discoveryRoot: root };
  const listed = listCandidates(registry);
  assert.ok(listed.includes(alpha));
  assert.ok(listed.includes(beta));
  assert.ok(!listed.some((entry) => entry.endsWith('.hidden') || entry.endsWith('notes.txt')));
  assert.ok(isAllowedProject(alpha, registry, '/fallback'));
  assert.ok(isAllowedProject(beta, registry, '/fallback'));
  assert.ok(!isAllowedProject('/elsewhere/gamma', registry, '/fallback'));
  assert.ok(!isAllowedProject('/fallback', { projects: [], discoveryRoot: root }, '/other'), 'unknown paths stay blocked');
  assert.equal(findExplicitPath('no path here'), null);
  assert.equal(findExplicitPath('edit ~/projects/alpha now'), '~/projects/alpha');
  const clarification = clarificationText(['/projects/alpha', '/projects/beta'], ['/projects/alpha']);
  assert.ok(clarification.includes('alpha') && clarification.includes('beta'));
  assert.ok(!clarification.includes('@opencode'), 'a clarification reply never retriggers');
});

test('each Muse chat keeps its own harness session', async () => {
  const server = await startRelay();
  const urlA = 'https://muse.ai/chat/thread-a';
  const urlB = 'https://muse.ai/chat/thread-b';
  await importItems(server, [
    museMessage({ text: 'Baseline A.', url: urlA, sourceId: 'baseline-a', ts: Date.now() + 5000 }),
    museMessage({ text: 'Baseline B.', url: urlB, sourceId: 'baseline-b', ts: Date.now() + 5000 }),
  ]);
  await sleep(300);
  assert.equal(readRuns(server).length, 0);

  await importItems(server, [museMessage({ role: 'user', text: '@opencode Task for A.', url: urlA, sourceId: 'a-1', ts: Date.now() + 5100 })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  await importItems(server, [museMessage({ role: 'user', text: '@opencode Task for B.', url: urlB, sourceId: 'b-1', ts: Date.now() + 5200 })]);
  await waitFor(async () => (readRuns(server).length >= 2 ? true : undefined));
  await importItems(server, [museMessage({ role: 'user', text: '@opencode Second task for A.', url: urlA, sourceId: 'a-2', ts: Date.now() + 5300 })]);
  await waitFor(async () => (readRuns(server).length >= 3 ? true : undefined));

  const runs = readRuns(server);
  assert.equal(runs.length, 3);
  const sessionA = sessionOf(runs[0]);
  const sessionB = sessionOf(runs[1]);
  assert.ok(sessionA && sessionB && sessionA !== sessionB, 'threads get different sessions');
  assert.equal(sessionOf(runs[2]), sessionA, 'the same thread reuses its session');
  assert.equal((await statusOf(server)).sessions, 2);
});

test('the first import of a conversation is baseline, not a trigger', async () => {
  const server = await startRelay();
  const url = 'https://muse.ai/chat/baseline-thread';
  await importItems(server, [
    museMessage({ text: '@opencode First agent line.', url, sourceId: 'baseline-1', ts: Date.now() + 5000 }),
    museMessage({ text: '@opencode Second agent line.', url, sourceId: 'baseline-2', ts: Date.now() + 5001 }),
  ]);
  await sleep(400);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await outboxOf(server)).items.length, 0);

  await importItems(server, [museMessage({ text: '@opencode Third agent line.', url, sourceId: 'baseline-3', ts: Date.now() + 5002 })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 1);
  assert.match(runs[0].prompt, /Third agent line\./);
});

test('a duplicate import does not start a second run', async () => {
  const server = await startRelay();
  const item = museMessage({ text: '@opencode Run the duplicate check.', ts: Date.now() + 5000, sourceId: 'agent-dup' });
  assert.equal((await importItems(server, [item])).added, 1);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal((await importItems(server, [item])).added, 0);
  await sleep(300);
  assert.equal(readRuns(server).length, 1);
  assert.equal((await outboxOf(server)).items.length, 1);
});

test('stored backlog and older messages do not start a run', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-backlog-'));
  const before = createProxyServer(dataDir, {}, { relay: { enabled: false } });
  before.listen(0, '127.0.0.1');
  await once(before, 'listening');
  cleanups.push(async () => { await new Promise<void>((resolve) => before.close(() => resolve())); });
  const address = before.address();
  assert.ok(address && typeof address !== 'string');
  const beforeBase = `http://127.0.0.1:${address.port}`;
  await fetch(`${beforeBase}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [museMessage({ text: 'Old backlog message.', ts: Date.now() + 1000, sourceId: 'backlog-1' })] }),
  });
  await new Promise<void>((resolve) => before.close(() => resolve()));

  const server = await startRelay({ dataDir });
  await sleep(400);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await statusOf(server)).lastRun, null);

  await importItems(server, [museMessage({ text: 'Older than the high-water mark.', ts: Date.now() - 1000, sourceId: 'backlog-2' })]);
  await sleep(300);
  assert.equal(readRuns(server).length, 0);

  await importItems(server, [museMessage({ text: '@opencode Fresh message.', ts: Date.now() + 5000, sourceId: 'fresh-1' })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(readRuns(server).length, 1);
});

test('a harness failure records an error and queues nothing', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: '@opencode FAIL_HARNESS please break.', ts: Date.now() + 5000, sourceId: 'fail-1' })]);
  const status = await waitFor(async () => {
    const current = await statusOf(server);
    return current.lastRun?.state === 'error' ? current : undefined;
  });
  assert.match(status.lastRun?.error ?? '', /harness exited with code 3/);
  assert.equal((await outboxOf(server)).items.length, 0);
  assert.ok(!JSON.stringify(status).includes('FAIL_HARNESS'), 'the status has no message body');
});

test('a timeout kills the run and queues nothing', async () => {
  const server = await startRelay({ timeoutMs: 400 });
  await importItems(server, [museMessage({ text: '@opencode SLOW_HARNESS please wait.', ts: Date.now() + 5000, sourceId: 'slow-1' })]);
  const status = await waitFor(async () => {
    const current = await statusOf(server);
    return current.lastRun?.state === 'error' ? current : undefined;
  });
  assert.match(status.lastRun?.error ?? '', /timed out after 400 ms/);
  assert.equal((await outboxOf(server)).items.length, 0);

  const runs = readRuns(server);
  assert.equal(runs.length, 1);
  await waitFor(() => {
    try { process.kill(runs[0].pid, 0); return undefined; } catch { return true; }
  }, 3000);
});

test('a restart does not replay the previous message', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-restart-'));
  const first = await startRelay({ dataDir, removeDataOnClose: false });
  const item = museMessage({ text: '@opencode Run this one time.', ts: Date.now() + 5000, sourceId: 'restart-1' });
  await importItems(first, [item]);
  await waitFor(async () => (await statusOf(first)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(readRuns(first).length, 1);
  const queued = (await outboxOf(first)).items.length;
  assert.equal(queued, 1);
  await first.close();

  const server = await startRelay({ dataDir });
  await sleep(400);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await importItems(server, [item])).added, 0);
  await sleep(300);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await outboxOf(server)).items.length, queued, 'the restart does not queue a second reply');
});

test('the mention parser strips the token and the reply never retriggers', () => {
  assert.equal(extractMentionTask('@opencode Build the settings page.'), 'Build the settings page.');
  assert.equal(extractMentionTask('Hey @opencode fix the build please'), 'Hey  fix the build please');
  assert.equal(extractMentionTask('You:\n\n@opencode What is on my plate?'), 'What is on my plate?');
  assert.equal(extractMentionTask('@OPENCODE uppercase works.'), 'uppercase works.');
  assert.equal(extractMentionTask('No mention here.'), null);
  assert.equal(extractMentionTask('@opencode'), null);
  assert.equal(extractMentionTask('@opencode!'), null);
  assert.equal(sanitizeReply('done via @opencode run'), 'done via opencode run');
  assert.match(newSessionId(), /^ses_[A-Za-z0-9]{24}$/);
});

test('the harness command parser and relay defaults are bounded', () => {
  assert.deepEqual(splitCommand('opencode run --model local'), ['opencode', 'run', '--model', 'local']);
  assert.deepEqual(splitCommand('["C:\\\\Program Files\\\\node.exe","fake.mjs"]'), ['C:\\Program Files\\node.exe', 'fake.mjs']);
  assert.throws(() => splitCommand('[]'));
  assert.throws(() => splitCommand('[1,2]'));

  const defaults = buildRelayConfig('/tmp/blibs-data');
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.provider, 'muse');
  assert.equal(defaults.command, 'opencode run');
  assert.equal(defaults.timeoutMs, 120000);
  assert.equal(defaults.model, undefined);
  assert.equal(defaults.cwd, path.resolve('/tmp/blibs-data', 'harness'));
  const overridden = buildRelayConfig('/tmp/blibs-data', { enabled: false, provider: 'grok', timeoutMs: 400 });
  assert.equal(overridden.enabled, false);
  assert.equal(overridden.provider, 'grok');
  assert.equal(overridden.timeoutMs, 400);
  assert.equal(buildRelayConfig(process.cwd()).cwd, path.join(tmpdir(), 'blibs-harness'));
  assert.equal(isConversationThread('muse', 'https://muse.ai/'), false);
  assert.equal(isProviderThread('muse', 'https://muse.ai/'), true);
  assert.equal(isProviderThread('muse', 'https://example.com/'), false);
  assert.equal(isConversationThread('muse', 'https://muse.ai/chat/abc'), true);
  assert.equal(isConversationThread('muse', 'https://example.com/chat/abc'), false);
  assert.equal(isConversationThread('custom', 'unknown-thread'), true);
});
