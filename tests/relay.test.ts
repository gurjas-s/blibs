// Relay tests use a fake harness, temporary stores, and mocked rows.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createProxyServer } from '../server/proxy.ts';
import { HistoryStore } from '../server/history.ts';
import { splitCommand } from '../server/harness/opencode.ts';
import { buildRelayConfig, isConversationThread, isProviderThread, newSessionId } from '../server/relay.ts';
import { DEFAULT_PROJECTS } from '../server/relay-defaults.ts';
import {
  canonicalDir,
  clarificationText,
  findExplicitPath,
  isAllowedProject,
  listCandidates,
  resolveProject,
  sessionKey,
  threadProjects,
} from '../server/harness/router.ts';
import {
  buildProjectChoices,
  CHOICES_HEADER,
  formatHelp,
  formatProjectChoices,
  formatSessionChoices,
  isChoicesMessage,
  parseCommandBody,
} from '../server/harness/commands.ts';
import { searchHomeProjects } from '../server/harness/discovery.ts';
import { extractMentionBody, extractMentionTask, isUserTurn, sanitizeReply, startsWithMention } from '../server/harness/mention.ts';
import {
  BLIBS_MENTION,
  INTRO_HEADER,
  harnessTag,
  introMessage,
  isBlibsMention,
  isIntroMessage,
} from '../server/harness/intro.ts';
import { harnessHeader, harnessMessage } from '../server/harness/message.ts';
import { ROUTING_MCP_NAME, parseRoutingReply, routingPrompt } from '../server/harness/routing-agent.ts';

const FAKE_HARNESS = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--session-list') {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')); } catch {}
  process.stdout.write(JSON.stringify(map[process.cwd()] || []));
  process.exit(0);
}
const prompt = args.at(-1) || '';
fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify({ pid: process.pid, prompt, args, cwd: process.cwd(), pwd: process.env.PWD || '' }) + '\\n');
if (prompt.includes('FAIL_HARNESS')) {
  console.error('fake harness failed');
  process.exit(3);
}
if (prompt.includes('SLOW_HARNESS')) {
  setTimeout(() => process.exit(9), 10000);
} else if (prompt.includes('blibs routing agent')) {
  // The relay talks to the routing agent through the routing prompt. The
  // tests steer the agent with ROUTE: and ASKME markers or a route.json file.
  const routed = /ROUTE:(\\S+)/.exec(prompt);
  if (routed) process.stdout.write('FORWARD ' + routed[1] + '\\n');
  else if (prompt.includes('ASKME')) process.stdout.write('ASK Which project is this task for?\\n');
  else if (fs.existsSync(path.join(dir, 'route.json'))) process.stdout.write('FORWARD ' + fs.readFileSync(path.join(dir, 'route.json'), 'utf8').trim() + '\\n');
  else process.stdout.write('harness reply: no routing decision\\n');
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
  harness: { id: string; command: string; cwd: string; timeoutMs: number; model?: string };
  harnesses: Array<{ id: string; name: string; enabled: boolean }>;
  projects: string[];
  discoveryRoot: string;
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

async function startRelay(options: {
  dataDir?: string;
  timeoutMs?: number;
  model?: string;
  removeDataOnClose?: boolean;
  searchRoot?: string;
  sessions?: Record<string, Array<{ id: string; title?: string; updated?: number }>>;
} = {}): Promise<RelayServer> {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), 'blibs-relay-'));
  const harnessDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-harness-'));
  const fake = path.join(harnessDir, 'fake-harness.mjs');
  writeFileSync(fake, FAKE_HARNESS);
  if (options.sessions) writeFileSync(path.join(harnessDir, 'sessions.json'), JSON.stringify(options.sessions));
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
      // Tests isolate routing from the real home directory.
      projects: [],
      discoveryRoot: path.join(harnessDir, 'no-such-root'),
      sessionListCommand: JSON.stringify([process.execPath, fake, '--session-list']),
      searchRoot: options.searchRoot ?? path.join(harnessDir, 'no-such-home'),
      ...(options.model ? { model: options.model } : {}),
    },
  });
  server.listen(0, '127.0.0.1');
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

async function importsOf(server: RelayServer): Promise<{ imports: Array<{ text: string; role: string; threadId: string }> }> {
  return fetch(`${server.base}/api/imports`).then((response) => response.json() as Promise<{ imports: Array<{ text: string; role: string; threadId: string }> }>);
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

test('a user @opencode tag is ignored', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ role: 'user', text: '@opencode Fix the build.', ts: Date.now() + 5000, sourceId: 'user-tag-1' })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 0, 'the user tag starts no harness run');
  assert.equal((await outboxOf(server)).items.length, 0, 'the user tag sends no reply');
  assert.equal((await statusOf(server)).lastRun, null);
});


test('a provider @opencode message starts one run and queues one Muse outbox item', async () => {
  const server = await startRelay();
  const ts = Date.now() + 5000;
  const report = await importItems(server, [museMessage({ text: '@opencode Summarize the release notes.', ts, sourceId: 'user-1' })]);
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
  assert.equal(runs.length, 2, 'one routing run and one work run');
  // The routing run frames the agent, keeps its own session, and writes the MCP config.
  assert.match(runs[0].prompt, /blibs routing agent/);
  assert.match(runs[0].prompt, /Summarize the release notes\./);
  assert.ok(!runs[0].prompt.includes('@opencode'), 'the routing prompt has no mention token');
  assert.equal(runs[0].cwd, realpathSync(server.harnessDir), 'the routing agent runs in the harness directory');
  const mcpConfig = JSON.parse(readFileSync(path.join(server.harnessDir, 'opencode.json'), 'utf8')) as {
    mcp: { servers: Record<string, { type: string; command: string[] }> };
  };
  const routerServer = mcpConfig.mcp.servers[ROUTING_MCP_NAME];
  assert.ok(routerServer, 'the routing run exposes the router MCP server');
  assert.equal(routerServer.type, 'local');
  assert.ok(routerServer.command.includes(server.dataDir), 'the MCP server reads the relay state');
  // The work run carries the task alone and replies into the session.
  assert.equal(runs[1].prompt, 'Summarize the release notes.');
  assert.ok(!runs[1].args.includes('--model'), 'no model flag without a configured model');
  assert.ok(sessionOf(runs[1]), 'the work run carries a session id');
  assert.notEqual(sessionOf(runs[0]), sessionOf(runs[1]), 'the routing agent has its own session');
  assert.equal(runs[1].cwd, realpathSync(server.harnessDir), 'the work run starts in the resolved project');
  assert.equal(runs[1].pwd, realpathSync(server.harnessDir), 'the work run PWD matches its directory');

  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1);
  assert.equal(outbox.items[0].provider, 'muse');
  assert.ok(
    outbox.items[0].text.startsWith(harnessHeader('OpenCode')),
    'the harness reply says which harness sent it',
  );
  assert.ok(
    outbox.items[0].text.endsWith('harness reply: Summarize the release notes.'),
    'the harness text follows the header',
  );
  assert.equal(outbox.items[0].threadId, 'https://muse.ai/chat/relay-test');

  const blocked = await fetch(`${server.base}/api/relay`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(blocked.status, 403);
});

test('a Muse @opencode delegation starts a run', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: '@opencode Fix the build.', ts: Date.now() + 5000, sourceId: 'agent-delegate' })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].prompt, 'Fix the build.');
});

test('a message without a mention does not start a run', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: 'Summarize the release notes with no mention.', ts: Date.now() + 5000, sourceId: 'agent-plain' })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 0);
  assert.equal((await outboxOf(server)).items.length, 0);
  assert.equal((await statusOf(server)).lastRun, null);
});

test('an @blibs mention returns one introduction reply in the chat', async () => {
  const server = await startRelay();
  const url = 'https://muse.ai/chat/intro';
  const report = await importItems(server, [
    museMessage({ role: 'user', text: '@blibs What can you do?', url, sourceId: 'intro-1', ts: Date.now() + 5000 }),
  ]);
  assert.equal(report.added, 1);

  // The first batch of a conversation is baseline for harness work. The
  // introduction is safe to answer, so it replies even here.
  const intro = (await importsOf(server)).imports.find(
    (message) => message.threadId === url && message.text.startsWith(INTRO_HEADER),
  );
  assert.ok(intro, 'the chat gets one introduction reply');
  assert.equal(intro.role, 'agent', 'the panel shows the reply as an agent message');
  assert.match(intro.text, /Available harnesses: OpenCode\./);
  assert.match(intro.text, /Enabled for this assistant: OpenCode\./);
  assert.match(intro.text, /How tagging works:/);
  assert.match(intro.text, /How to choose a project and session:/);
  assert.match(intro.text, /\$find-project <task>/);
  assert.ok(intro.text.endsWith('To give it a try do @opencode.'), 'the reply ends with the project list request');
  assert.equal(readRuns(server).length, 0, 'the introduction starts no harness run');
  const introOutbox = await outboxOf(server);
  assert.equal(introOutbox.items.length, 1, 'the introduction is sent into the chat');
  assert.equal(introOutbox.items[0].provider, 'muse');
  assert.equal(introOutbox.items[0].threadId, url);
  assert.ok(introOutbox.items[0].text.startsWith(INTRO_HEADER));
  assert.ok(introOutbox.items[0].text.endsWith('To give it a try do @opencode.'), 'the sent reply keeps the example tag');

  // An echo of the reply never answers itself.
  await importItems(server, [
    museMessage({ role: 'agent', text: `You:\n\n${intro.text}`, url, sourceId: 'intro-echo', ts: Date.now() + 5100 }),
  ]);
  await sleep(300);
  assert.equal(
    (await importsOf(server)).imports.filter((message) => message.text.startsWith(INTRO_HEADER)).length,
    1,
    'the reply echo does not start a second introduction',
  );
  assert.equal((await outboxOf(server)).items.length, 1, 'the reply echo sends nothing');

  // Muse can label the same bubble as "User message:" instead of "You:".
  await importItems(server, [
    museMessage({ role: 'agent', text: `User message: ${intro.text}`, url, sourceId: 'intro-echo-label', ts: Date.now() + 5150 }),
  ]);
  await sleep(200);
  assert.equal(
    (await importsOf(server)).imports.filter((message) => message.text.startsWith(INTRO_HEADER)).length,
    1,
    'a labeled reply echo does not start another introduction',
  );
  assert.equal((await outboxOf(server)).items.length, 1);
  assert.equal(readRuns(server).length, 0, 'a labeled reply echo starts no harness run');

  // A second @blibs message gets a second answer.
  await importItems(server, [
    museMessage({ role: 'user', text: '@BLIBS again', url, sourceId: 'intro-2', ts: Date.now() + 5200 }),
  ]);
  await sleep(100);
  assert.equal(
    (await importsOf(server)).imports.filter((message) => message.text.startsWith(INTRO_HEADER)).length,
    2,
  );
  assert.equal((await outboxOf(server)).items.length, 2);
  assert.equal(readRuns(server).length, 0);
});

test('a bare @opencode lists the known projects and starts no run', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-projects-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const server = await startRelay({ dataDir });
  const projA = path.join(dataDir, 'proj-alpha');
  const projB = path.join(dataDir, 'proj-beta');
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA, projB], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);

  const url = 'https://muse.ai/chat/project-choices';
  await importItems(server, [museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'pc-base', ts: Date.now() + 5000 })]);
  await sleep(300);
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode', url, sourceId: 'pc-1', ts: Date.now() + 5100 })]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));

  const outbox = await outboxOf(server);
  const text = outbox.items[0].text;
  assert.ok(text.startsWith(CHOICES_HEADER), 'the reply is a choice list');
  assert.ok(text.includes('$proj-alpha'), 'the first project has a token');
  assert.ok(text.includes('$proj-beta'), 'the second project has a token');
  assert.ok(!text.includes(realpathSync(projA)), 'the reply omits the project path');
  assert.equal(readRuns(server).length, 0, 'the list starts no harness run');
  assert.equal((await statusOf(server)).lastRun?.state, 'ok');

  const imported = await importsOf(server);
  assert.ok(imported.imports.some((message) => message.threadId === url && message.text.startsWith(CHOICES_HEADER)), 'the panel gets the choice list');

  // A vendor echo of the reply must not retrigger.
  await importItems(server, [museMessage({ role: 'agent', text: `You:\n\n${text}`, url, sourceId: 'pc-echo', ts: Date.now() + 5200 })]);
  await sleep(300);
  assert.equal(readRuns(server).length, 0, 'the echo starts no run');
  assert.equal((await outboxOf(server)).items.length, 1, 'the echo sends no second list');
});

test('a session choice continues one OpenCode session without the routing agent', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-sessions-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const projA = path.join(dataDir, 'proj-alpha');
  mkdirSync(projA, { recursive: true });
  const projectPath = realpathSync(projA);
  const server = await startRelay({
    dataDir,
    sessions: { [projectPath]: [{ id: 'ses_alpha', title: 'Alpha work', updated: Date.now() }] },
  });
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);

  const url = 'https://muse.ai/chat/session-choices';
  await importItems(server, [museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'sc-base', ts: Date.now() + 5000 })]);
  await sleep(300);
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode $proj-alpha', url, sourceId: 'sc-1', ts: Date.now() + 5100 })]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));
  const sessionList = (await outboxOf(server)).items[0].text;
  assert.ok(sessionList.startsWith(CHOICES_HEADER));
  assert.ok(sessionList.includes('$proj-alpha-ses_alpha'), 'the real session id becomes a choice');
  assert.ok(sessionList.includes('Alpha work'), 'the session title is shown');
  assert.equal(readRuns(server).length, 0, 'listing sessions starts no harness run');

  await importItems(server, [museMessage({
    role: 'agent',
    text: '@opencode $proj-alpha-ses_alpha Fix the build',
    url,
    sourceId: 'sc-2',
    ts: Date.now() + 5200,
  })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 1, 'the direct choice starts one work run and no routing run');
  assert.equal(runs[0].prompt, 'Fix the build');
  assert.equal(sessionOf(runs[0]), 'ses_alpha');
  assert.equal(runs[0].cwd, projectPath);
  const state = JSON.parse(readFileSync(path.join(dataDir, 'relay-state.json'), 'utf8')) as { sessions: Record<string, string> };
  assert.equal(state.sessions[sessionKey(url, projectPath)], 'ses_alpha', 'the chosen session sticks to the thread');
});

test('a new session choice creates one session and runs the task', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-new-session-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const server = await startRelay({ dataDir });
  const projA = path.join(dataDir, 'proj-alpha');
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);

  const url = 'https://muse.ai/chat/new-session';
  await importItems(server, [museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'ns-base', ts: Date.now() + 5000 })]);
  await sleep(300);
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode $proj-alpha-new Start fresh', url, sourceId: 'ns-1', ts: Date.now() + 5100 })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 1);
  const created = sessionOf(runs[0]);
  assert.match(created ?? '', /^ses_[A-Za-z0-9]{24}$/);
  const state = JSON.parse(readFileSync(path.join(dataDir, 'relay-state.json'), 'utf8')) as { sessions: Record<string, string> };
  assert.equal(state.sessions[sessionKey(url, realpathSync(projA))], created);
});

test('find-project lists the home search and routes a task to a found project', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-find-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const home = mkdtempSync(path.join(tmpdir(), 'blibs-relay-home-'));
  const alpha = path.join(home, 'alpha');
  const beta = path.join(home, 'beta');
  mkdirSync(path.join(alpha, '.git'), { recursive: true });
  mkdirSync(beta);
  writeFileSync(path.join(beta, 'package.json'), '{}');
  const server = await startRelay({ dataDir, searchRoot: home });
  try {
    const url = 'https://muse.ai/chat/find-project';
    await importItems(server, [museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'fp-base', ts: Date.now() + 5000 })]);
    await sleep(300);

    await importItems(server, [museMessage({ role: 'agent', text: '@opencode $find-project', url, sourceId: 'fp-list', ts: Date.now() + 5100 })]);
    await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));
    const list = (await outboxOf(server)).items[0].text;
    assert.ok(list.startsWith(CHOICES_HEADER));
    assert.ok(list.includes('Projects found in your home folder:'));
    assert.ok(list.includes('$alpha'));
    assert.ok(list.includes('$beta'));
    assert.equal(readRuns(server).length, 0, 'the bare search starts no routing run');

    writeFileSync(path.join(server.harnessDir, 'route.json'), realpathSync(alpha));
    await importItems(server, [museMessage({
      role: 'agent',
      text: '@opencode $find-project Fix the alpha build',
      url,
      sourceId: 'fp-run',
      ts: Date.now() + 5200,
    })]);
    await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
    const runs = readRuns(server);
    assert.equal(runs.length, 2, 'the agent route and the work run start');
    assert.ok(runs[0].prompt.includes(realpathSync(alpha)), 'the routing prompt carries the discovered project');
    assert.equal(runs[1].cwd, realpathSync(alpha), 'the task runs in the discovered project');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a found project keeps its token when the registry has the same folder name', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-found-token-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const home = mkdtempSync(path.join(tmpdir(), 'blibs-relay-found-home-'));
  const homeProject = path.join(home, 'app');
  mkdirSync(path.join(homeProject, '.git'), { recursive: true });
  const registryProject = path.join(dataDir, 'registry', 'app');
  const server = await startRelay({
    dataDir,
    searchRoot: home,
    sessions: { [realpathSync(homeProject)]: [{ id: 'ses_home', title: 'Home session', updated: Date.now() }] },
  });
  try {
    const post = await fetch(`${server.base}/api/relay/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [registryProject], discoveryRoot: emptyRoot }),
    });
    assert.equal(post.status, 200);

    const url = 'https://muse.ai/chat/found-token';
    await importItems(server, [museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'ft-base', ts: Date.now() + 5000 })]);
    await sleep(300);
    await importItems(server, [museMessage({ role: 'agent', text: '@opencode $find-project', url, sourceId: 'ft-list', ts: Date.now() + 5100 })]);
    await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));
    const list = (await outboxOf(server)).items[0].text;
    assert.ok(!list.includes(realpathSync(homeProject)), 'the found list omits the project path');
    const token = /^- \$([^\s]+)/m.exec(list)?.[1];
    assert.ok(token, 'the found project has a token');
    assert.match(token, /^app-[0-9a-f]{4}$/, 'the duplicate basename gets a stable suffix');

    await importItems(server, [museMessage({ role: 'agent', text: `@opencode $${token}`, url, sourceId: 'ft-sessions', ts: Date.now() + 5200 })]);
    await waitFor(async () => ((await outboxOf(server)).items.length >= 2 ? true : undefined));
    const sessions = (await outboxOf(server)).items[1].text;
    assert.ok(sessions.includes(`$${token}-ses_home`), 'the found token resolves to the found project');
    assert.ok(!sessions.includes('No sessions yet.'), 'the found project is not replaced by the registry project');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a bare @opencode in the first batch lists projects without running work', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-baseline-choice-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const server = await startRelay({ dataDir });
  const projA = path.join(dataDir, 'proj-alpha');
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);

  const url = 'https://muse.ai/chat/baseline-choice';
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode', url, sourceId: 'bc-1', ts: Date.now() + 5000 })]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));
  assert.ok((await outboxOf(server)).items[0].text.includes('$proj-alpha'));
  assert.equal(readRuns(server).length, 0, 'the baseline list request starts no work');
});

test('the panel report controls the harness list in the introduction', async () => {
  const server = await startRelay();
  const harnesses = [
    { id: 'claude-code', name: 'Claude Code', enabled: true },
    { id: 'codex', name: 'Codex', enabled: false },
    { id: 'opencode', name: 'OpenCode', enabled: true },
  ];
  const posted = await fetch(`${server.base}/api/relay/harnesses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harnesses }),
  });
  assert.equal(posted.status, 200);
  const status = await statusOf(server);
  assert.deepEqual(status.harnesses, harnesses, 'the relay keeps the reported rows');

  const badShape = await fetch(`${server.base}/api/relay/harnesses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harnesses: [{ id: 'codex' }] }),
  });
  assert.equal(badShape.status, 400);
  const badType = await fetch(`${server.base}/api/relay/harnesses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harnesses: [{ id: 'codex', name: 'Codex', enabled: 'yes' }] }),
  });
  assert.equal(badType.status, 400);

  const url = 'https://muse.ai/chat/intro-report';
  await importItems(server, [
    museMessage({ role: 'user', text: '@blibs list the harnesses', url, sourceId: 'intro-report-1', ts: Date.now() + 5000 }),
  ]);
  const intro = (await importsOf(server)).imports.find(
    (message) => message.threadId === url && message.text.startsWith(INTRO_HEADER),
  );
  assert.ok(intro);
  assert.match(intro.text, /Available harnesses: Claude Code, Codex, OpenCode\./);
  assert.match(intro.text, /Enabled for this assistant: Claude Code, OpenCode\./);
  assert.ok(!/Enabled for this assistant:.*Codex/.test(intro.text), 'a disabled harness is not listed as enabled');
});

test('a cleared chat can ask blibs again and later tasks run', async () => {
  const server = await startRelay();
  const url = 'https://muse.ai/chat/clear-reset';
  await importItems(server, [
    museMessage({ role: 'agent', text: '@opencode Old baseline task.', url, sourceId: 'clear-base-task', ts: Date.now() + 5000 }),
    museMessage({ role: 'user', text: '@blibs', url, sourceId: 'clear-base-intro', ts: Date.now() + 5001 }),
  ]);
  await sleep(300);
  assert.equal(readRuns(server).length, 0, 'the baseline task starts no run');
  assert.equal(
    (await importsOf(server)).imports.filter((message) => message.text.startsWith(INTRO_HEADER)).length,
    1,
    'the baseline introduction is answered once',
  );

  // A new scrape can re-render an old bubble with a new position and message id.
  await importItems(server, [
    museMessage({ role: 'agent', text: '@opencode Old baseline task.', url, sourceId: 'clear-replay', ts: Date.now() + 5100 }),
  ]);
  await waitFor(async () => (readRuns(server).length >= 2 ? true : undefined));
  assert.equal(readRuns(server).length, 2, 'a re-rendered provider task runs');

  // `/clear` resets the vendor context, so the next identical @blibs mention answers again.
  await importItems(server, [
    museMessage({ role: 'agent', text: 'You:\n\n/clear', url, sourceId: 'clear-command', ts: Date.now() + 5200 }),
  ]);
  await sleep(100);
  await importItems(server, [
    museMessage({ role: 'user', text: '@blibs', url, sourceId: 'clear-intro-2', ts: Date.now() + 5300 }),
  ]);
  await sleep(200);
  assert.equal(
    (await importsOf(server)).imports.filter((message) => message.text.startsWith(INTRO_HEADER)).length,
    2,
    'the cleared chat gets a new introduction',
  );
  assert.equal(readRuns(server).length, 2, 'the introduction still starts no harness run');

  // The same task text after a clear is a new request, not a re-scrape.
  await importItems(server, [
    museMessage({ role: 'agent', text: '@opencode Old baseline task.', url, sourceId: 'clear-task-again', ts: Date.now() + 5400 }),
  ]);
  await waitFor(async () => (readRuns(server).length >= 4 ? true : undefined));
  assert.equal(readRuns(server)[3].prompt, 'Old baseline task.');
});

test('a /clear and @blibs in one batch send the introduction', async () => {
  const server = await startRelay();
  const url = 'https://muse.ai/chat/same-batch-clear';
  await importItems(server, [museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'sb-base', ts: Date.now() + 5000 })]);
  await sleep(200);

  // Muse stamps both rows with the same time. The clear must not hide the next trigger.
  const ts = Date.now() + 5100;
  await importItems(server, [
    museMessage({ role: 'agent', text: 'You:\n\n/clear', url, sourceId: 'sb-clear', ts }),
    museMessage({ role: 'agent', text: 'You:\n\n@blibs', url, sourceId: 'sb-intro', ts }),
  ]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));
  const outbox = await outboxOf(server);
  assert.ok(outbox.items[0].text.startsWith(INTRO_HEADER), 'the same batch still sends the introduction');
  assert.equal(readRuns(server).length, 0, 'the introduction starts no harness run');
});

test('an assistant explanation with a mention in the middle starts no work', async () => {
  const server = await startRelay();
  const url = 'https://muse.ai/chat/explanation-mention';
  await importItems(server, [museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'em-base', ts: Date.now() + 5000 })]);
  await sleep(200);
  await importItems(server, [museMessage({
    role: 'agent',
    text: 'what do you want to send through it? need a harness + task, like @opencode $project',
    url,
    sourceId: 'em-1',
    ts: Date.now() + 5100,
  })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 0, 'the explanation starts no routing run');
  assert.equal((await outboxOf(server)).items.length, 0, 'the explanation sends no reply');

  // A leading delegation from the same assistant still starts work.
  await importItems(server, [museMessage({
    role: 'agent',
    text: '@opencode A real delegation.',
    url,
    sourceId: 'em-2',
    ts: Date.now() + 5200,
  })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(readRuns(server).length, 2, 'a leading delegation still runs');
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
    museMessage({ role: 'agent', text: '@opencode What is on my plate today?', url, sourceId: 'user-mention', ts: echoTs + 1000 }),
  ]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(readRuns(server).length, 2);
  assert.equal(readRuns(server)[1].prompt, 'What is on my plate today?');

  // The reply typed back into Muse is also a "You:" echo. It must not run.
  await importItems(server, [museMessage({ role: 'agent', text: 'You:\n\nharness reply', url, sourceId: 'reply-echo', ts: echoTs + 2000 })]);
  await sleep(400);
  assert.equal(readRuns(server).length, 2);
});

test('a configured model reaches every harness command', async () => {
  const server = await startRelay({ model: 'test-provider/test-model' });
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Summarize the model run.', ts: Date.now() + 5000, sourceId: 'model-1' })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 2);
  assert.equal(modelOf(runs[0]), 'test-provider/test-model', 'the routing run carries the model');
  assert.equal(modelOf(runs[1]), 'test-provider/test-model', 'the work run carries the model');
  assert.equal(runs[1].cwd, realpathSync(server.harnessDir), 'the model flag does not change the directory');
});

test('the project registry persists over the local API', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-registry-'));
  const server = await startRelay({ dataDir, removeDataOnClose: false });
  const projA = path.join(dataDir, 'proj-a');
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA], model: 'test-provider/test-model' }),
  });
  assert.equal(post.status, 200);
  const updated = await statusOf(server);
  assert.deepEqual(updated.projects, [realpathSync(projA)]);
  assert.equal(updated.harness.model, 'test-provider/test-model');
  assert.ok(existsSync(projA), 'the registry creates project directories');
  assert.ok(updated.discoveryRoot.length > 0);

  const bad = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: 'not-an-array' }),
  });
  assert.equal(bad.status, 400);
  await server.close();

  const restarted = await startRelay({ dataDir });
  assert.deepEqual((await statusOf(restarted)).projects, [realpathSync(projA)], 'the registry survives a restart');
  assert.equal((await statusOf(restarted)).harness.model, 'test-provider/test-model');
});

test('one Muse thread routes two projects to two sessions', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-multi-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const server = await startRelay({ dataDir });
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [path.join(dataDir, 'proj-alpha'), path.join(dataDir, 'proj-beta')], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);
  const projA = path.join(dataDir, 'proj-alpha');
  const projB = path.join(dataDir, 'proj-beta');

  const url = 'https://muse.ai/chat/multi-project';
  await importItems(server, [museMessage({ text: 'Baseline.', url, sourceId: 'mp-base', ts: Date.now() + 5000 })]);
  await sleep(300);
  await importItems(server, [museMessage({ role: 'agent', text: `@opencode Fix the build in ${projA}`, url, sourceId: 'mp-a1', ts: Date.now() + 5100 })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Fix the proj-beta flake', url, sourceId: 'mp-b1', ts: Date.now() + 5200 })]);
  await waitFor(async () => (readRuns(server).length >= 4 ? true : undefined));
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Polish the proj-alpha UI', url, sourceId: 'mp-a2', ts: Date.now() + 5300 })]);
  await waitFor(async () => (readRuns(server).length >= 6 ? true : undefined));

  const runs = readRuns(server);
  assert.equal(runs.length, 6, 'each task runs the routing agent, then the work run');
  assert.equal(runs[1].cwd, realpathSync(projA), 'the first task runs in its project');
  assert.equal(runs[3].cwd, realpathSync(projB), 'the second task runs in its project');
  assert.equal(runs[5].cwd, realpathSync(projA), 'the third task returns to its project');
  const sessionA = sessionOf(runs[1]);
  const sessionB = sessionOf(runs[3]);
  assert.ok(sessionA && sessionB && sessionA !== sessionB, 'projects get different sessions');
  assert.equal(sessionOf(runs[5]), sessionA, 'the same project reuses its session');
  const routerSessions = new Set([sessionOf(runs[0]), sessionOf(runs[2]), sessionOf(runs[4])]);
  assert.equal(routerSessions.size, 1, 'the routing agent keeps one session across tasks');
  assert.notEqual([...routerSessions][0], sessionA, 'the routing session is not a project session');
  assert.equal((await statusOf(server)).sessions, 2);
});

test('an unclear task runs the routing agent once and asks', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-unclear-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const server = await startRelay({ dataDir });
  const projA = path.join(dataDir, 'proj-alpha');
  const projB = path.join(dataDir, 'proj-beta');
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA, projB], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);

  const url = 'https://muse.ai/chat/unclear-project';
  await importItems(server, [museMessage({ text: 'Baseline.', url, sourceId: 'up-base', ts: Date.now() + 5000 })]);
  await sleep(300);
  const item = museMessage({ role: 'agent', text: '@opencode Do the thing', url, sourceId: 'up-1', ts: Date.now() + 5100 });
  await importItems(server, [item]);
  await waitFor(async () => (await outboxOf(server)).items.length >= 1 ? true : undefined);
  const runs = readRuns(server);
  assert.equal(runs.length, 1, 'the routing agent runs, but no work run starts without a project');
  assert.match(runs[0].prompt, /blibs routing agent/);
  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1);
  assert.ok(outbox.items[0].text.startsWith(harnessHeader('OpenCode')), 'the routing question says which harness asked');
  assert.ok(outbox.items[0].text.includes('Which project'), 'the user gets one question');
  assert.ok(!outbox.items[0].text.includes('@opencode'), 'the question never retriggers');
  const status = await statusOf(server);
  assert.equal(status.lastRun?.state, 'ok', 'the asked question completes the run');

  assert.equal((await importItems(server, [item])).added, 0);
  await sleep(300);
  assert.equal((await outboxOf(server)).items.length, 1, 'a duplicate import asks nothing twice');
  assert.equal(readRuns(server).length, 1, 'a duplicate import runs nothing twice');
});

test('the routing agent forwards a task to the project it picks', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-forward-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const server = await startRelay({ dataDir });
  const projA = path.join(dataDir, 'proj-alpha');
  const projB = path.join(dataDir, 'proj-beta');
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA, projB], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);
  // The fake agent reads route.json, so its answer cannot come from the task text.
  writeFileSync(path.join(server.harnessDir, 'route.json'), projA);

  const url = 'https://muse.ai/chat/agent-forward';
  await importItems(server, [museMessage({ text: 'Baseline.', url, sourceId: 'af-base', ts: Date.now() + 5000 })]);
  await sleep(300);
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Fix the build', url, sourceId: 'af-1', ts: Date.now() + 5100 })]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));

  const runs = readRuns(server);
  assert.equal(runs.length, 2, 'the agent decision runs the work harness once');
  assert.equal(runs[1].cwd, realpathSync(projA), 'the work run starts in the project the agent picked');
  assert.ok(sessionOf(runs[1]), 'the work run continues the project session');
  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1);
  assert.ok(outbox.items[0].text.startsWith(harnessHeader('OpenCode')), 'the work reply carries the harness header');
  assert.ok(outbox.items[0].text.includes('harness reply:'), 'the work reply reaches the thread');
  assert.ok(!outbox.items[0].text.includes('FORWARD'), 'the routing decision never reaches the thread');
  assert.equal((await statusOf(server)).lastRun?.state, 'ok');
});

test('a routing question reaches the thread and starts no work run', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: '@opencode Please ASKME which project.', ts: Date.now() + 5000, sourceId: 'ask-1' })]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));
  assert.equal(readRuns(server).length, 1, 'the routing run is the only run');
  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1);
  assert.equal(
    outbox.items[0].text,
    `${harnessHeader('OpenCode')}\n\nWhich project is this task for?`,
  );
  assert.ok(!outbox.items[0].text.includes('@opencode'), 'the question never retriggers');
  assert.equal((await statusOf(server)).lastRun?.state, 'ok');
});

test('a routing answer outside the allowlist falls back and asks', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-oustide-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const server = await startRelay({ dataDir });
  const projA = path.join(dataDir, 'proj-alpha');
  const projB = path.join(dataDir, 'proj-beta');
  const post = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [projA, projB], discoveryRoot: emptyRoot }),
  });
  assert.equal(post.status, 200);
  writeFileSync(path.join(server.harnessDir, 'route.json'), path.join(dataDir, 'elsewhere'));

  const url = 'https://muse.ai/chat/agent-outside';
  await importItems(server, [museMessage({ text: 'Baseline.', url, sourceId: 'ao-base', ts: Date.now() + 5000 })]);
  await sleep(300);
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Fix the build', url, sourceId: 'ao-1', ts: Date.now() + 5100 })]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));

  assert.equal(readRuns(server).length, 1, 'no work run starts for a rejected project');
  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1);
  assert.ok(outbox.items[0].text.startsWith(harnessHeader('OpenCode')), 'the fallback question says which harness asked');
  assert.ok(outbox.items[0].text.includes('Which project'), 'the keyword fallback asks the user');
});

test('the routing agent session survives a restart', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-router-session-'));
  const first = await startRelay({ dataDir, removeDataOnClose: false });
  await importItems(first, [museMessage({ text: '@opencode Route once.', ts: Date.now() + 5000, sourceId: 'rs-1' })]);
  await waitFor(async () => (await statusOf(first)).lastRun?.state === 'ok' ? true : undefined);
  const firstSession = sessionOf(readRuns(first)[0]);
  assert.ok(firstSession, 'the routing run carries a session id');
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'relay-state.json'), 'utf8')) as { routerSessionId?: string };
  assert.equal(saved.routerSessionId, firstSession, 'the routing session persists in the relay state');
  await first.close();

  const server = await startRelay({ dataDir });
  await importItems(server, [museMessage({ text: '@opencode Route twice.', ts: Date.now() + 6000, sourceId: 'rs-2' })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(sessionOf(readRuns(server)[0]), firstSession, 'the restart reuses the routing session');
});

test('the routing prompt and reply contract stay strict', () => {
  const prompt = routingPrompt('Fix the build.', 'https://example.com/chat/x');
  assert.ok(prompt.includes('Fix the build.'));
  assert.ok(prompt.includes('https://example.com/chat/x'));
  assert.ok(prompt.includes(ROUTING_MCP_NAME));
  assert.ok(!prompt.includes('@opencode'), 'the routing prompt carries no mention token');
  assert.ok(!/Muse/i.test(prompt), 'the routing prompt names no provider');
  assert.match(prompt, /only job is to choose the project/, 'the router does not own the work');
  assert.match(prompt, /message unchanged/, 'the project session receives the message unchanged');
  assert.deepEqual(
    parseRoutingReply('Reading the registry.\nFORWARD /projects/alpha'),
    { kind: 'forward', projectPath: '/projects/alpha' },
  );
  assert.deepEqual(
    parseRoutingReply('ASK Which project is this task for?'),
    { kind: 'ask', question: 'Which project is this task for?' },
  );
  assert.equal(parseRoutingReply('harness reply: no routing decision'), null);
  assert.deepEqual(
    parseRoutingReply('FORWARD /a\nASK which project?'),
    { kind: 'ask', question: 'which project?' },
    'the last decision line wins',
  );
});

test('one Muse thread can own one session per project', () => {
  const alpha = path.resolve('/projects/alpha');
  const beta = path.resolve('/projects/beta');
  const sessions: Record<string, string> = {};
  sessions[sessionKey('thread-a', alpha)] = 'ses_alpha';
  sessions[sessionKey('thread-a', beta)] = 'ses_beta';
  sessions[sessionKey('thread-b', alpha)] = 'ses_other';
  assert.deepEqual(threadProjects(sessions, 'thread-a'), [alpha, beta]);
  assert.deepEqual(threadProjects(sessions, 'thread-b'), [alpha]);
  assert.deepEqual(threadProjects(sessions, 'thread-unknown'), []);
  assert.notEqual(sessionKey('t', '/a'), sessionKey('t', '/b'), 'projects get distinct keys');
  assert.notEqual(sessionKey('t', '/a'), sessionKey('o', '/a'), 'threads get distinct keys');
});

test('the project router picks explicit paths, names, and thread memory', () => {
  const alpha = path.resolve('/projects/alpha');
  const beta = path.resolve('/projects/beta');
  const candidates = [alpha, beta];
  assert.equal(
    resolveProject('Fix the build in /projects/alpha today', [], candidates)?.projectPath,
    alpha,
  );
  assert.equal(
    resolveProject('Fix the beta flake', [], candidates)?.projectPath,
    beta,
  );
  assert.equal(resolveProject('Sync alpha and beta', [], candidates), null, 'two name hits need a question');
  assert.equal(
    resolveProject('Do more work', [alpha, beta], candidates)?.confidence,
    'map-hit',
  );
  assert.equal(
    resolveProject('Do more work', [alpha, beta], candidates)?.projectPath,
    beta,
  );
  assert.equal(resolveProject('Do work', [], []), null, 'no registry means the relay falls back');
  assert.equal(
    resolveProject('Fix it in /elsewhere/gamma', [], candidates)?.projectPath,
    path.resolve('/elsewhere/gamma'),
    'the caller enforces the allowlist after canonicalization',
  );
  const onlyProject = path.resolve('/only/project');
  assert.equal(resolveProject('Do work', [], [onlyProject])?.projectPath, onlyProject);
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

test('the router MCP answers tool calls', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-router-mcp-'));
  const projB = path.join(dataDir, 'proj-beta');
  mkdirSync(projB);
  const threadId = 'https://muse.ai/chat/t';
  writeFileSync(path.join(dataDir, 'relay-state.json'), JSON.stringify({
    version: 2, watermark: 1, processed: [], threads: [],
    sessions: { [`${threadId}\n${projB}`]: 'ses_beta' },
    projects: [path.join(dataDir, 'proj-alpha'), projB], discoveryRoot: dataDir, runs: 0, lastRun: null,
  }));
  const child = spawn(process.execPath, ['--import', 'tsx', path.join('server', 'router-mcp.ts'), '--data-dir', dataDir], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    const lines: string[] = [];
    child.stdout?.setEncoding('utf8');
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the MCP server timed out')), 20000);
      child.stdout?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) if (line.trim()) lines.push(line);
        if (lines.length >= 5) { clearTimeout(timer); resolve(); }
      });
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'resolve_project', arguments: { task: 'Fix the proj-beta flake', threadId } },
    })}\n`);
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'resolve_session', arguments: { threadId, projectPath: projB } },
    })}\n`);
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'resolve_session', arguments: { threadId, projectPath: path.join(dataDir, 'proj-alpha') } },
    })}\n`);
    await ready;
    const listed = JSON.parse(lines[1]) as { result: { tools: Array<{ name: string }> } };
    assert.ok(listed.result.tools.some((tool) => tool.name === 'resolve_project'));
    assert.ok(listed.result.tools.some((tool) => tool.name === 'resolve_session'), 'the MCP resolves the session of a project');
    assert.ok(listed.result.tools.some((tool) => tool.name === 'search_projects'), 'the MCP can search the home folder');
    const called = JSON.parse(lines[2]) as { result: { content: Array<{ text: string }> } };
    const answer = JSON.parse(called.result.content[0].text) as { projectPath: string; confidence: string };
    assert.equal(answer.projectPath, projB);
    assert.equal(answer.confidence, 'match');
    const sessionAnswer = JSON.parse((JSON.parse(lines[3]) as { result: { content: Array<{ text: string }> } }).result.content[0].text) as { session: string | null };
    assert.equal(sessionAnswer.session, 'ses_beta', 'a routed project resolves to its session');
    const noSession = JSON.parse((JSON.parse(lines[4]) as { result: { content: Array<{ text: string }> } }).result.content[0].text) as { session: string | null };
    assert.equal(noSession.session, null, 'an unrouted project has no session yet');
  } finally {
    child.kill();
  }
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

  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Task for A.', url: urlA, sourceId: 'a-1', ts: Date.now() + 5100 })]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Task for B.', url: urlB, sourceId: 'b-1', ts: Date.now() + 5200 })]);
  await waitFor(async () => (readRuns(server).length >= 4 ? true : undefined));
  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Second task for A.', url: urlA, sourceId: 'a-2', ts: Date.now() + 5300 })]);
  await waitFor(async () => (readRuns(server).length >= 6 ? true : undefined));

  const runs = readRuns(server);
  assert.equal(runs.length, 6);
  const sessionA = sessionOf(runs[1]);
  const sessionB = sessionOf(runs[3]);
  assert.ok(sessionA && sessionB && sessionA !== sessionB, 'threads get different sessions');
  assert.equal(sessionOf(runs[5]), sessionA, 'the same thread reuses its session');
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
  assert.equal(runs.length, 2);
  assert.equal(runs[1].prompt, 'Third agent line.');
});

test('a duplicate import does not start a second run', async () => {
  const server = await startRelay();
  const item = museMessage({ text: '@opencode Run the duplicate check.', ts: Date.now() + 5000, sourceId: 'agent-dup' });
  assert.equal((await importItems(server, [item])).added, 1);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal((await importItems(server, [item])).added, 0);
  await sleep(300);
  assert.equal(readRuns(server).length, 2);
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
  assert.equal(readRuns(server).length, 2);
});

test('a provider command runs when the vendor re-renders it', async () => {
  const server = await startRelay();
  const url = 'https://muse.ai/chat/rescrape';
  await importItems(server, [
    museMessage({ role: 'user', text: 'Baseline.', url, sourceId: 'rescrape-base', ts: Date.now() + 5000 }),
  ]);
  await sleep(100);

  const text = '@opencode Summarize the duplicate scrape.';
  await importItems(server, [
    museMessage({ role: 'agent', text, url, sourceId: 'rescrape-1', ts: Date.now() + 5100 }),
  ]);
  await waitFor(async () => (await statusOf(server)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(readRuns(server).length, 2);
  assert.equal((await outboxOf(server)).items.length, 1);

  // The same bubble at a new page position gets a new source id and a later
  // observation time. Provider commands do not have a text dedupe.
  await importItems(server, [
    museMessage({ role: 'agent', text, url, sourceId: 'rescrape-2', ts: Date.now() + 5200 }),
  ]);
  await waitFor(async () => (readRuns(server).length >= 4 ? true : undefined));
  assert.equal(readRuns(server).length, 4, 'the re-rendered provider command runs');
  await waitFor(async () => ((await outboxOf(server)).items.length >= 2 ? true : undefined));
  assert.equal((await outboxOf(server)).items.length, 2, 'the re-rendered provider command replies');
});

test('a harness failure records an error and tells the chat', async () => {
  const server = await startRelay();
  await importItems(server, [museMessage({ text: '@opencode FAIL_HARNESS please break.', ts: Date.now() + 5000, sourceId: 'fail-1' })]);
  const status = await waitFor(async () => {
    const current = await statusOf(server);
    return current.lastRun?.state === 'error' ? current : undefined;
  });
  assert.match(status.lastRun?.error ?? '', /harness exited with code 3/);
  assert.equal(readRuns(server).length, 1, 'a failed routing run forwards no work');
  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1, 'the chat gets one failure note');
  assert.match(outbox.items[0].text, /routing agent failed/);
  assert.match(outbox.items[0].text, /exited with code 3/);
  assert.ok(!outbox.items[0].text.includes('FAIL_HARNESS'), 'the failure note has no message body');
  assert.ok(!JSON.stringify(status).includes('FAIL_HARNESS'), 'the status has no message body');
});

test('a timeout kills the run and tells the chat', async () => {
  const server = await startRelay({ timeoutMs: 400 });
  await importItems(server, [museMessage({ text: '@opencode SLOW_HARNESS please wait.', ts: Date.now() + 5000, sourceId: 'slow-1' })]);
  const status = await waitFor(async () => {
    const current = await statusOf(server);
    return current.lastRun?.state === 'error' ? current : undefined;
  });
  assert.match(status.lastRun?.error ?? '', /timed out after 400 ms/);
  const outbox = await outboxOf(server);
  assert.equal(outbox.items.length, 1, 'the chat gets one failure note');
  assert.match(outbox.items[0].text, /timed out after 400 ms/);

  const runs = readRuns(server);
  assert.equal(runs.length, 1);
  await waitFor(() => {
    try { process.kill(runs[0].pid, 0); return undefined; } catch { return true; }
  }, 3000);
});

test('a stale session does not hide the current project registry', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-stale-'));
  const emptyRoot = path.join(dataDir, 'empty-root');
  mkdirSync(emptyRoot);
  const url = 'https://muse.ai/chat/relay-test';
  const stale = path.join(dataDir, 'stale-project');
  const target = path.join(dataDir, 'current-project');
  writeFileSync(path.join(dataDir, 'relay-state.json'), JSON.stringify({
    version: 2,
    watermark: 1,
    processed: [],
    threads: [url],
    sessions: { [`${url}\n${stale}`]: 'ses_stale' },
    projects: [],
    discoveryRoot: emptyRoot,
    runs: 0,
    lastRun: null,
  }));
  const server = await startRelay({ dataDir });
  const registry = await fetch(`${server.base}/api/relay/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: [target], discoveryRoot: emptyRoot }),
  });
  assert.equal(registry.status, 200);

  await importItems(server, [museMessage({ role: 'agent', text: '@opencode Do the work', url, sourceId: 'stale-1', ts: Date.now() + 5000 })]);
  await waitFor(async () => ((await outboxOf(server)).items.length >= 1 ? true : undefined));
  const runs = readRuns(server);
  assert.equal(runs.length, 2, 'the work run starts for the allowed project');
  assert.equal(runs[1].cwd, realpathSync(target), 'the stale session is not used');
  const outbox = await outboxOf(server);
  assert.ok(outbox.items[0].text.startsWith(harnessHeader('OpenCode')));
});

test('a restart does not replay the previous message', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-restart-'));
  const first = await startRelay({ dataDir, removeDataOnClose: false });
  const item = museMessage({ text: '@opencode Run this one time.', ts: Date.now() + 5000, sourceId: 'restart-1' });
  await importItems(first, [item]);
  await waitFor(async () => (await statusOf(first)).lastRun?.state === 'ok' ? true : undefined);
  assert.equal(readRuns(first).length, 2);
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
  assert.equal(extractMentionTask('User message: @opencode hi'), 'hi');
  assert.equal(extractMentionTask('Assistant message: @opencode fix it'), 'fix it');
  assert.equal(extractMentionTask('@OPENCODE uppercase works.'), 'uppercase works.');
  assert.equal(extractMentionTask('No mention here.'), null);
  assert.equal(extractMentionTask('@opencode'), null);
  assert.equal(extractMentionTask('@opencode!'), null);
  assert.equal(extractMentionBody('@opencode'), '', 'a bare mention asks for the project list');
  assert.equal(extractMentionBody('You:\n\n@opencode $proj'), '$proj');
  assert.equal(extractMentionBody('No mention here.'), null);
  assert.equal(startsWithMention('@opencode fix it'), true);
  assert.equal(startsWithMention('You:\n\n@opencode fix it'), true);
  assert.equal(startsWithMention('what about @opencode fix it'), false, 'a mention in a sentence is not a trigger');
  assert.equal(isUserTurn('You:\n\n@opencode fix it'), true);
  assert.equal(isUserTurn('User message: @opencode fix it'), true);
  assert.equal(isUserTurn('@opencode fix it'), false);
  assert.equal(sanitizeReply('done via @opencode run'), 'done via opencode run');
  assert.match(newSessionId(), /^ses_[A-Za-z0-9]{24}$/);
});

test('the choice protocol parses projects, sessions, new sessions, and the fallback', () => {
  const projects = buildProjectChoices(['/projects/alpha', '/projects/beta', '/projects/alpha']);
  assert.deepEqual(projects, [
    { path: path.resolve('/projects/alpha'), token: 'alpha' },
    { path: path.resolve('/projects/beta'), token: 'beta' },
  ]);
  assert.deepEqual(parseCommandBody('', projects), { kind: 'projects' });
  assert.deepEqual(parseCommandBody('  ', projects), { kind: 'projects' });
  assert.deepEqual(parseCommandBody('fix the build', projects), { kind: 'routing', task: 'fix the build' });
  assert.deepEqual(parseCommandBody('$alpha', projects), { kind: 'sessions', project: projects[0] });
  assert.deepEqual(parseCommandBody('$sessions $alpha', projects), { kind: 'sessions', project: projects[0] });
  assert.deepEqual(parseCommandBody('$sessions alpha', projects), { kind: 'sessions', project: projects[0] });
  assert.equal(parseCommandBody('$sessions', projects).kind, 'help');
  assert.equal(parseCommandBody('$sessions $missing', projects).kind, 'help');
  assert.deepEqual(parseCommandBody('$alpha-new fix it', projects), { kind: 'run-new', project: projects[0], task: 'fix it' });
  assert.deepEqual(
    parseCommandBody('$alpha-ses_abc fix it', projects),
    { kind: 'run-session', project: projects[0], sessionId: 'ses_abc', task: 'fix it' },
  );
  assert.deepEqual(parseCommandBody('$find-project', []), { kind: 'find-projects' });
  assert.deepEqual(parseCommandBody('$find-project find it', []), { kind: 'find-run', task: 'find it' });
  assert.equal(parseCommandBody('$missing', projects).kind, 'help');
  assert.equal(parseCommandBody('$alpha fix it', projects).kind, 'help', 'a project alone never runs a task');
  assert.equal(parseCommandBody('$alpha-new', projects).kind, 'help', 'a new session needs a task');
  assert.equal(parseCommandBody('$alpha-ses_abc', projects).kind, 'help', 'a session needs a task');
});

test('duplicate project names get stable unique tokens', () => {
  const first = buildProjectChoices(['/work/a/app', '/work/b/app']);
  const second = buildProjectChoices(['/work/b/app', '/work/a/app']);
  assert.equal(first.length, 2);
  assert.equal(new Set(first.map((entry) => entry.token)).size, 2);
  assert.match(first[0].token, /^app-[0-9a-f]{4}$/);
  assert.deepEqual(
    new Map(first.map((entry) => [entry.path, entry.token])),
    new Map(second.map((entry) => [entry.path, entry.token])),
    'the token follows the path, not the list position',
  );
  const reserved = buildProjectChoices(['/work/find-project', '/work/app-new', '/work/sessions', '/work/app']);
  assert.ok(reserved.every((entry) => !['find-project', 'app-new', 'sessions'].includes(entry.token)), 'reserved command names are escaped');
});

test('the choice replies show the tokens and never ask for a plain task', () => {
  const projects = buildProjectChoices(['/projects/alpha', '/projects/beta']);
  const projectText = formatProjectChoices(projects, { mention: '@opencode', harnessName: 'OpenCode' });
  assert.ok(projectText.startsWith(CHOICES_HEADER));
  assert.ok(projectText.includes('$alpha'));
  assert.ok(!projectText.includes('/projects/alpha'), 'the reply omits the project path');
  assert.ok(projectText.includes('@opencode $sessions $<project>'));
  assert.ok(projectText.includes('before you start a new one'));
  assert.ok(isChoicesMessage(projectText));
  assert.ok(isChoicesMessage(`You:\n\n${projectText}`));
  assert.ok(!isChoicesMessage('A normal message'));
  const sessionText = formatSessionChoices(projects[0], [
    { id: 'ses_abc', title: 'Fix the build', updated: Date.now() - 60_000 },
  ], { mention: '@opencode', harnessName: 'OpenCode' });
  assert.ok(sessionText.includes('$alpha-ses_abc'));
  assert.ok(sessionText.includes('Fix the build'));
  assert.ok(sessionText.includes('Prefer an existing session'));
  assert.ok(sessionText.includes('$alpha-new <task>'));
  const help = formatHelp('Unknown choice $missing.', { mention: '@opencode', harnessName: 'OpenCode' });
  assert.ok(help.startsWith(CHOICES_HEADER));
  assert.ok(help.includes('Unknown choice'));
});

test('the home-folder search finds marked projects and skips heavy folders', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'blibs-discovery-'));
  mkdirSync(path.join(root, 'alpha', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'beta'));
  writeFileSync(path.join(root, 'beta', 'package.json'), '{}');
  mkdirSync(path.join(root, 'nested', 'gamma'), { recursive: true });
  writeFileSync(path.join(root, 'nested', 'gamma', 'pyproject.toml'), '');
  mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'ignored', 'package.json'), '{}');
  mkdirSync(path.join(root, '.hidden'), { recursive: true });
  writeFileSync(path.join(root, '.hidden', 'package.json'), '{}');
  mkdirSync(path.join(root, 'Library', 'ignored'), { recursive: true });
  writeFileSync(path.join(root, 'Library', 'ignored', 'package.json'), '{}');
  try {
    const result = searchHomeProjects({ root });
    const names = result.projects.map((entry) => path.basename(entry.path)).sort();
    assert.deepEqual(names, ['alpha', 'beta', 'gamma']);
    assert.equal(result.truncated, false);
    assert.ok(!result.projects.some((entry) => entry.path.includes('node_modules')));
    assert.ok(!result.projects.some((entry) => entry.path.includes('.hidden')));
    assert.ok(!result.projects.some((entry) => entry.path.includes('Library')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the @blibs trigger, introduction text, and harness header stay stable', () => {
  assert.equal(BLIBS_MENTION, '@blibs');
  assert.equal(isBlibsMention('@blibs What can you do?'), true);
  assert.equal(isBlibsMention('You:\n\n@blibs hi'), true);
  assert.equal(isBlibsMention('User message: @blibs hi'), true);
  assert.equal(isBlibsMention('@BLIBS uppercase works'), true);
  assert.equal(isBlibsMention('Ask @blibs.'), true);
  assert.equal(isBlibsMention('write to @blibs.example'), false);
  assert.equal(isBlibsMention('no mention here'), false);
  assert.equal(isIntroMessage('You:\n\nblibs introduction\n\nblibs is...'), true);
  assert.equal(isIntroMessage('User message: blibs introduction\n\nblibs is...'), true);
  assert.equal(isIntroMessage('Assistant message: blibs introduction'), true);
  assert.equal(isIntroMessage('A normal message'), false);

  const text = introMessage([
    { id: 'claude-code', name: 'Claude Code', enabled: true },
    { id: 'codex', name: 'Codex', enabled: false },
    { id: 'opencode', name: 'OpenCode', enabled: true },
  ]);
  assert.ok(text.startsWith(INTRO_HEADER));
  assert.ok(text.includes('Available harnesses: Claude Code, Codex, OpenCode.'));
  assert.ok(text.includes('Enabled for this assistant: Claude Code, OpenCode.'));
  assert.ok(text.includes('How tagging works:'));
  assert.ok(text.includes('How to choose a project and session:'));
  assert.ok(text.includes(`${harnessTag('opencode')} fix the failing test`), 'the example uses the preferred enabled harness');
  assert.ok(text.includes(`${harnessTag('opencode')} $sessions $<project> lists the sessions of one project.`));
  assert.ok(text.includes(`${harnessTag('opencode')} $<project>-new <task> starts a new session.`));
  assert.ok(text.includes('Check the sessions before you start a new one.'));
  assert.ok(text.includes(`${harnessTag('opencode')} $find-project <task> searches your home folder`));
  assert.ok(text.endsWith(`To give it a try do ${harnessTag('opencode')}.`));
  assert.ok(introMessage([]).includes('OpenCode'), 'an empty report falls back to the build harnesses');
  const codexOnly = introMessage([
    { id: 'claude-code', name: 'Claude Code', enabled: false },
    { id: 'codex', name: 'Codex', enabled: true },
  ]);
  assert.ok(codexOnly.endsWith(`To give it a try do ${harnessTag('codex')}.`), 'a disabled preferred harness falls back to the first enabled harness');
  assert.ok(codexOnly.includes(`${harnessTag('codex')} fix the failing test`), 'the example follows the enabled harness');
  assert.ok(codexOnly.includes(`${harnessTag('codex')} $sessions $<project> lists the sessions of one project.`), 'the commands follow the enabled harness');
  const noneEnabled = introMessage([{ id: 'codex', name: 'Codex', enabled: false }]);
  assert.ok(noneEnabled.includes('no harness yet'), 'a report with no enabled harness says so');
  assert.ok(noneEnabled.includes('Turn on a harness in Connections'), 'the reply says how to enable a harness');
  assert.ok(!noneEnabled.includes('To give it a try'), 'no enabled harness means no test tag line');

  assert.equal(
    harnessMessage('  done  ', 'OpenCode'),
    "Sent from user's harness (OpenCode).\n\ndone",
  );
  assert.equal(harnessMessage('   ', 'OpenCode'), '');
  assert.equal(harnessHeader('Codex'), "Sent from user's harness (Codex).");
});

test('the harness command parser and relay defaults are bounded', () => {
  assert.deepEqual(splitCommand('opencode run --model local'), ['opencode', 'run', '--model', 'local']);
  assert.deepEqual(splitCommand('["C:\\\\Program Files\\\\node.exe","fake.mjs"]'), ['C:\\Program Files\\node.exe', 'fake.mjs']);
  assert.throws(() => splitCommand('[]'));
  assert.throws(() => splitCommand('[1,2]'));

  const defaults = buildRelayConfig('/tmp/blibs-data');
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.provider, 'muse');
  assert.equal(defaults.harnessId, 'opencode', 'the registry default harness is opencode');
  assert.equal(defaults.command, 'opencode run');
  assert.equal(buildRelayConfig('/tmp/blibs-data', { harnessId: 'unknown' }).harnessId, 'opencode', 'an unknown harness id falls back');
  assert.equal(defaults.timeoutMs, 120000);
  assert.equal(defaults.model, undefined);
  assert.deepEqual(defaults.projects, DEFAULT_PROJECTS, 'a fresh install starts with the two known projects');
  assert.ok(defaults.projects.every((dir) => path.isAbsolute(dir)));
  assert.ok(defaults.discoveryRoot.endsWith('Projects'));
  assert.deepEqual(buildRelayConfig('/tmp/blibs-data', { projects: [] }).projects, [], 'an explicit empty registry is not the default');
  assert.equal(defaults.cwd, canonicalDir(path.resolve('/tmp/blibs-data', 'harness')));
  assert.equal(buildRelayConfig(process.cwd()).cwd, canonicalDir(path.join(tmpdir(), 'blibs-harness')));
  const overridden = buildRelayConfig('/tmp/blibs-data', { enabled: false, provider: 'grok', timeoutMs: 400 });
  assert.equal(overridden.enabled, false);
  assert.equal(overridden.provider, 'grok');
  assert.equal(overridden.timeoutMs, 400);
  assert.equal(isConversationThread('muse', 'https://muse.ai/'), false);
  assert.equal(isProviderThread('muse', 'https://muse.ai/'), true);
  assert.equal(isProviderThread('muse', 'https://example.com/'), false);
  assert.equal(isConversationThread('muse', 'https://muse.ai/chat/abc'), true);
  assert.equal(isConversationThread('muse', 'https://example.com/chat/abc'), false);
  assert.equal(isConversationThread('custom', 'unknown-thread'), true);
});
