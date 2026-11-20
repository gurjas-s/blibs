// Relay tests use a fake harness, temporary projects, and mocked Muse rows.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createProxyServer } from '../server/proxy.ts';
import { HistoryStore } from '../server/history.ts';
import { buildProjectChoices, formatProjectList, formatUnknownProject } from '../server/harness/project-reply.ts';
import { listProjects, matchProject, taskAfterProject } from '../server/harness/projects.ts';
import { introMessage } from '../server/harness/intro.ts';
import { buildRelayConfig, newSessionId } from '../server/relay.ts';
import { DEFAULT_RELAY_MODEL } from '../server/relay-defaults.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RelayServer {
  base: string;
  dataDir: string;
  harnessDir: string;
  projectsDir: string;
  alpha: string;
}

const FAKE_HARNESS = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const prompt = args.at(-1) || '';
fs.appendFileSync(path.join('__LOG_DIR__', 'runs.jsonl'), JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\\n');
if (prompt.includes('FAIL_HARNESS')) process.exit(3);
process.stdout.write('harness reply: ' + prompt + '\\n');
`;

async function startRelay(): Promise<RelayServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-data-'));
  const harnessDir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-harness-'));
  const projectsDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'blibs-relay-projects-')));
  const alpha = path.join(projectsDir, 'alpha');
  mkdirSync(alpha);
  mkdirSync(path.join(projectsDir, 'beta'));
  const fake = path.join(harnessDir, 'fake-harness.mjs');
  writeFileSync(fake, FAKE_HARNESS.replace("'__LOG_DIR__'", JSON.stringify(harnessDir)));
  const seed = new HistoryStore(dataDir);
  seed.import([{ provider: 'muse', role: 'user', text: 'Earlier message.', ts: 1, url: 'https://muse.ai/chat/relay-test', sourceId: 'seed-user', identity: 'source-id' }]);
  seed.close();
  const server = createProxyServer(dataDir, {}, { relay: {
    enabled: true,
    provider: 'muse',
    command: JSON.stringify([process.execPath, fake]),
    cwd: harnessDir,
    timeoutMs: 5000,
    discoveryRoot: projectsDir,
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });
  return { base, dataDir, harnessDir, projectsDir, alpha };
}

let importTimestamp = Date.now() + 1000;
async function importMuse(server: RelayServer, text: string, id: string, role = 'agent'): Promise<void> {
  importTimestamp = Math.max(importTimestamp + 1000, Date.now() + 1000);
  const response = await fetch(`${server.base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{
      provider: 'muse', role, text, ts: importTimestamp,
      url: 'https://muse.ai/chat/relay-test', sourceId: id, identity: 'source-id',
    }] }),
  });
  assert.equal(response.status, 200);
}

async function outbox(server: RelayServer): Promise<Array<{ text: string; threadId?: string }>> {
  return (await (await fetch(`${server.base}/api/outbox`)).json() as { items: Array<{ text: string; threadId?: string }> }).items;
}

function runs(server: RelayServer): Array<{ args: string[]; prompt: string; cwd: string }> {
  try {
    return readFileSync(path.join(server.harnessDir, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; prompt: string; cwd: string });
  } catch { return []; }
}

async function waitForRunCount(server: RelayServer, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (runs(server).length >= count) return;
    await sleep(25);
  }
  assert.fail(`Expected ${count} harness run(s).`);
}

test('project matcher lists only immediate folders and resolves names, tokens, and paths', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'blibs-projects-')));
  const alpha = path.join(root, 'alpha');
  mkdirSync(alpha);
  mkdirSync(path.join(alpha, 'nested'), { recursive: true });
  try {
    const projects = listProjects(root);
    assert.deepEqual(projects, [alpha]);
    const choices = buildProjectChoices(projects);
    const pathTask = path.join(alpha, 'nested') + ' fix the build';
    for (const [text, via] of [['$alpha fix the build', 'token'], ['alpha fix the build', 'name'], [pathTask, 'path']]) {
      const match = matchProject(text, choices);
      assert.deepEqual(match, { kind: 'project', choice: choices[0], via });
      assert.equal(match.kind, 'project');
      assert.equal(taskAfterProject(text, match), 'fix the build');
    }
    assert.deepEqual(matchProject('$missing fix the build', choices), { kind: 'unknown', name: 'missing' });
    assert.equal(matchProject('fix the build', choices).kind, 'none');
    assert.equal(matchProject('budget is $100', choices).kind, 'none');
    assert.equal(matchProject('summarize https://example.com/path', choices).kind, 'none');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a task without a project asks Muse to choose, then runs in the selected project', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode build a small app', 'list-projects');
  await sleep(150);
  const list = await outbox(server);
  assert.equal(list.length, 1);
  assert.match(list[0].text, /\$alpha/);
  assert.match(list[0].text, /\$beta/);
  assert.match(list[0].text, /Reply with @opencode \$<project> <task>/);
  assert.equal(runs(server).length, 0);

  await importMuse(server, '@opencode $alpha build a small app', 'run-alpha');
  await waitForRunCount(server, 1);
  const first = runs(server)[0];
  assert.equal(first.cwd, server.alpha);
  assert.equal(first.prompt, 'build a small app');
  assert.ok(first.args.includes(DEFAULT_RELAY_MODEL));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await outbox(server)).length < 2) await sleep(25);
  assert.match((await outbox(server))[1].text, /harness reply: build a small app/);
});

test('each displayed project token selects its own folder and preserves the task', async () => {
  const server = await startRelay();
  for (const name of ['My project', 'my-project']) mkdirSync(path.join(server.projectsDir, name));
  const choices = buildProjectChoices(listProjects(server.projectsDir));
  const matching = choices.filter((choice) => choice.token.startsWith('my-project'));
  assert.equal(matching.length, 2);
  assert.equal(new Set(matching.map((choice) => choice.token)).size, 2);

  await importMuse(server, '@opencode', 'list-colliding-projects');
  const prompt = 'explain the /api/status route for @blibs';
  for (const [index, choice] of matching.entries()) {
    assert.ok((await outbox(server))[0].text.includes(`- $${choice.token}\n`));
    await importMuse(server, `@opencode $${choice.token} ${prompt}`, `project-token-${index}`);
    await waitForRunCount(server, index + 1);
    const run = runs(server)[index];
    assert.equal(run.cwd, choice.path);
    assert.equal(run.prompt, prompt);
  }
});

test('the relay reuses one session per project and thread', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode $alpha first task', 'first-task');
  await waitForRunCount(server, 1);
  await importMuse(server, '@opencode $alpha second task', 'second-task');
  await waitForRunCount(server, 2);
  const current = runs(server);
  const sessionArg = (args: string[]): string | undefined => args[args.indexOf('--session') + 1];
  assert.equal(sessionArg(current[0].args), sessionArg(current[1].args));
  assert.ok(sessionArg(current[0].args)?.startsWith('ses_'));
  assert.ok(newSessionId().startsWith('ses_'));
});

test('a user-authored harness tag does not start a run', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode $alpha do not run', 'user-tag', 'user');
  await sleep(150);
  assert.equal(runs(server).length, 0);
  assert.equal((await outbox(server)).length, 0);
});

test('a harness failure sends a visible reason to the chat', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode $alpha FAIL_HARNESS', 'failed-run');
  await waitForRunCount(server, 1);
  const deadline = Date.now() + 5000;
  let items: Array<{ text: string }> = [];
  while (Date.now() < deadline) {
    items = await outbox(server);
    if (items.some((item) => /harness failed/i.test(item.text))) break;
    await sleep(25);
  }
  assert.match(items.at(-1)?.text ?? '', /harness failed/i);
});

test('an unknown project gets the create-project instruction without a harness run', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode $missing build it', 'missing-project');
  await sleep(150);
  const replies = await outbox(server);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /project "missing" does not exist/i);
  assert.match(replies[0].text, /blibs new-project <name>/);
  assert.equal(runs(server).length, 0);
});

test('project replies ask the assistant to choose, and the blibs introduction explains routing', () => {
  const options = { mention: '@opencode', root: '/Users/test/Projects' };
  const choices = buildProjectChoices(['/Users/test/Projects/alpha']);
  const projectList = formatProjectList(choices, options);
  assert.match(projectList, /Pick a project for your task:/);
  assert.match(projectList, /- \$alpha/);
  assert.match(projectList, /Reply with @opencode \$<project> <task>/);
  assert.match(formatUnknownProject('missing', options), /blibs new-project <name>/);
  const intro = introMessage([{ id: 'opencode', name: 'OpenCode', enabled: true }]);
  assert.match(intro, /blibs is a desktop control panel/);
  assert.match(intro, /How tagging works:/);
  assert.match(intro, /sends that task to OpenCode/);
  assert.match(intro, /send @opencode followed by a task/);
  assert.doesNotMatch(intro, /project|\$<project>/i);
  assert.doesNotMatch(intro, /\$find-project|\$sessions|routing agent/i);
});

test('the default relay model uses the personal Beam Free provider', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-config-'));
  try { assert.equal(buildRelayConfig(dir).model, DEFAULT_RELAY_MODEL); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
