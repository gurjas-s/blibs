// Relay tests use a fake harness, temporary projects, and mocked Muse rows.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createProxyServer } from '../server/proxy.ts';
import { HistoryStore } from '../server/history.ts';
import { buildProjectChoices, formatProjectList } from '../server/harness/project-reply.ts';
import { listProjects, matchProject, sessionKey, taskAfterProject } from '../server/harness/projects.ts';
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
  restart: () => Promise<void>;
}

const FAKE_HARNESS = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const prompt = args.at(-1) || '';
fs.appendFileSync(path.join('__LOG_DIR__', 'runs.jsonl'), JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\\n');
const session = args[args.indexOf('--session') + 1];
const historyFile = path.join('__LOG_DIR__', session + '.txt');
fs.appendFileSync(historyFile, prompt + '\\n');
const write = /^write (first|second)\\.txt (.+)$/.exec(prompt);
if (write) fs.writeFileSync(write[1] + '.txt', write[2]);
if (prompt.includes('FAIL_HARNESS')) process.exit(3);
if (prompt.includes('WAIT_HARNESS')) {
  process.stderr.write('private diagnostic text');
  while (!fs.existsSync(path.join('__LOG_DIR__', 'release'))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
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
  writeFileSync(fake, FAKE_HARNESS.replaceAll("'__LOG_DIR__'", JSON.stringify(harnessDir)));
  const seed = new HistoryStore(dataDir);
  seed.import([{ provider: 'muse', role: 'user', text: 'Earlier message.', ts: 1, url: 'https://muse.ai/chat/relay-test', sourceId: 'seed-user', identity: 'source-id' }]);
  seed.close();
  const createServer = () => createProxyServer(dataDir, {}, { relay: {
    enabled: true,
    provider: 'muse',
    command: JSON.stringify([process.execPath, fake]),
    cwd: harnessDir,
    discoveryRoot: projectsDir,
  } });
  let server = createServer();
  const result = { base: '', dataDir, harnessDir, projectsDir, alpha, restart };
  async function listen(): Promise<void> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    result.base = `http://127.0.0.1:${address.port}`;
  }
  async function close(): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  async function restart(): Promise<void> {
    await close();
    server = createServer();
    await listen();
  }
  await listen();
  cleanups.push(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });
  return result;
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

test('a project choice lists sessions and an explicit command starts work', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode build a small app', 'list-projects');
  const list = await outbox(server);
  assert.equal(list.length, 1);
  assert.match(list[0].text, /\$alpha/);
  assert.match(list[0].text, /\$beta/);
  assert.equal(runs(server).length, 0);

  const selection = selectAlpha(list[0].text);
  await importMuse(server, '@opencode build a small app', 'rescanned-list-projects');
  assert.equal((await outbox(server)).length, 1);
  await importMuse(server, selection, 'select-alpha');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /No sessions for \$alpha/);
  assert.equal(runs(server).length, 0);
  await importMuse(server, selection, 'select-alpha');
  assert.equal((await outbox(server)).length, 2);
  await importMuse(server, selection, 'rescanned-select-alpha');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /no longer active/);
  assert.equal(runs(server).length, 0);

  await importMuse(server, '@opencode /new $alpha app build a small app', 'run-alpha');
  await waitForRunCount(server, 1);
  assert.equal(runs(server)[0].cwd, server.alpha);
  assert.equal(runs(server)[0].prompt, 'build a small app');
  assert.ok(runs(server)[0].args.includes(DEFAULT_RELAY_MODEL));
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
    await importMuse(server, `@opencode /new $${choice.token} inspect ${prompt}`, `project-token-${index}`);
    await waitForRunCount(server, index + 1);
    const run = runs(server)[index];
    assert.equal(run.cwd, choice.path);
    assert.equal(run.prompt, prompt);
  }
});

test('a plain project task never starts or reuses a session', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode $alpha first task', 'implicit-new');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /No sessions for \$alpha/);
  assert.equal(runs(server).length, 0);
  await importMuse(server, '@opencode /new $alpha first first task', 'first-task');
  await waitForRunCount(server, 1);
  await importMuse(server, '@opencode $alpha second task', 'implicit-resume');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /Sessions for \$alpha/);
  assert.equal(runs(server).length, 1);
  await importMuse(server, '@opencode /resume $alpha first second task', 'second-task');
  await waitForRunCount(server, 2);
  const current = runs(server);
  const sessionArg = (args: string[]): string | undefined => args[args.indexOf('--session') + 1];
  assert.equal(sessionArg(current[0].args), sessionArg(current[1].args));
  assert.ok(sessionArg(current[0].args)?.startsWith('ses_'));
  assert.ok(newSessionId().startsWith('ses_'));
});

test('named sessions keep separate histories and resume by name after restart', async () => {
  const server = await startRelay();
  const legacyId = newSessionId();
  writeFileSync(path.join(server.dataDir, 'relay-state.json'), JSON.stringify({
    version: 2,
    sessions: { [sessionKey('https://muse.ai/chat/relay-test', server.alpha)]: legacyId },
  }));
  await server.restart();

  await importMuse(server, '@blibs', 'session-intro', 'user');
  const intro = (await outbox(server)).at(-1)?.text ?? '';
  assert.ok(intro.includes('@opencode /new $<project> <name> <task>'));
  assert.ok(intro.includes('@opencode /sessions $<project>'));
  assert.ok(intro.includes('@opencode /resume $<project> <name> <task>'));
  assert.doesNotMatch(intro, /ask the user/i);

  await importMuse(server, '@opencode /new $alpha first write first.txt initial', 'named-first');
  await importMuse(server, '@opencode /new $alpha second write second.txt separate', 'named-second');
  await waitForRunCount(server, 2);
  const [firstId, secondId] = runs(server).map(({ args }) => args[args.indexOf('--session') + 1]);
  assert.notEqual(firstId, secondId);
  assert.notEqual(firstId, legacyId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await (await fetch(server.base + '/api/relay')).json()).running) await sleep(25);
  assert.equal((await (await fetch(server.base + '/api/relay')).json()).running, false);
  await server.restart();

  await importMuse(server, '@opencode /sessions $alpha', 'show-sessions');
  const list = (await outbox(server)).at(-1)?.text ?? '';
  assert.deepEqual(list.split('\n').filter((line) => line.startsWith('- ')), ['- Default', '- first', '- second']);
  for (const id of [legacyId, firstId, secondId]) assert.ok(!list.includes(id));
  await importMuse(server, '@opencode $alpha update the file', 'ambiguous-session');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /Sessions for \$alpha/);
  await importMuse(server, '@opencode /resume $alpha unknown-name do not run', 'unknown-session');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /session is unavailable/);
  await importMuse(server, '@opencode /resume $alpha ses_unknown do not run', 'unknown-session-id');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /session is unavailable/);
  await importMuse(server, '@opencode /resume $beta first do not run', 'wrong-project-session');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /session is unavailable/);
  await importMuse(server, '@opencode /new $alpha FIRST do not run', 'duplicate-session-name');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /different session name/);
  assert.equal(runs(server).length, 2);

  await importMuse(server, '@opencode /resume $alpha FIRST write first.txt updated', 'resume-first');
  const notices = (await outbox(server)).filter(({ text }) => text.endsWith('Active session for $alpha: first.'));
  assert.equal(notices.length, 2);
  await importMuse(server, `@opencode /resume $alpha ${secondId} check second.txt`, 'resume-second');
  await importMuse(server, '@opencode /resume $alpha Default check legacy task', 'resume-legacy');
  await waitForRunCount(server, 5);
  assert.deepEqual(runs(server).slice(2).map(({ args }) => args[args.indexOf('--session') + 1]), [firstId, secondId, legacyId]);
  assert.equal(readFileSync(path.join(server.alpha, 'first.txt'), 'utf8'), 'updated');
  assert.equal(readFileSync(path.join(server.alpha, 'second.txt'), 'utf8'), 'separate');
  assert.deepEqual(readFileSync(path.join(server.harnessDir, firstId + '.txt'), 'utf8').trim().split('\n'),
    ['write first.txt initial', 'write first.txt updated']);
  assert.deepEqual(readFileSync(path.join(server.harnessDir, secondId + '.txt'), 'utf8').trim().split('\n'),
    ['write second.txt separate', 'check second.txt']);
});

test('a user-authored harness tag does not start a run', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode /new $alpha unused do not run', 'user-tag', 'user');
  await sleep(150);
  assert.equal(runs(server).length, 0);
  assert.equal((await outbox(server)).length, 0);
});

test('a harness failure sends a visible reason to the chat', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode /new $alpha failure FAIL_HARNESS', 'failed-run');
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

test('different projects run together and same-project tasks wait and reuse the session', async (t) => {
  const logs = t.mock.method(console, 'info', () => {});
  const server = await startRelay();
  await importMuse(server, '@opencode /new $alpha waiting WAIT_HARNESS', 'waiting-run');
  await waitForRunCount(server, 1);
  await importMuse(server, '@opencode /resume $alpha waiting next task', 'queued-run');
  assert.equal(runs(server).length, 1);
  const waiting = await (await fetch(server.base + '/api/relay')).json();
  assert.equal(waiting.pending, 2);
  assert.equal(waiting.running, true);
  await importMuse(server, '@opencode /new $beta independent independent task', 'parallel-run');
  await waitForRunCount(server, 2);
  assert.match(runs(server)[1].prompt, /independent task/);
  const deadline = Date.now() + 5000;
  while ((await outbox(server)).length < 3 && Date.now() < deadline) await sleep(25);
  assert.equal((await outbox(server)).length, 3);
  assert.match((await outbox(server))[2].text, /independent task/);

  writeFileSync(path.join(server.harnessDir, 'release'), '');
  while ((await outbox(server)).length < 6 && Date.now() < deadline) await sleep(25);
  const items = await outbox(server);
  assert.equal(items.length, 6);
  assert.match(items[3].text, /WAIT_HARNESS/);
  assert.match(items[4].text, /Active session for \$alpha: waiting/);
  assert.match(items[5].text, /next task/);
  const sessionArg = (run: ReturnType<typeof runs>[number]) => run.args[run.args.indexOf('--session') + 1];
  const [first, independent, followUp] = runs(server);
  assert.equal(sessionArg(first), sessionArg(followUp));
  assert.notEqual(sessionArg(first), sessionArg(independent));

  const lines = logs.mock.calls.map(({ arguments: [line] }) => String(line));
  const events = lines.map((line) => JSON.parse(line));
  const start = events.find((event) => event.event === 'harness-start');
  const result = events.find((event) => event.event === 'harness-result' && event.messageId === start.messageId);
  assert.equal(result.messageId, start.messageId);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.spawned, true);
  assert.equal(result.processExited, true);
  assert.equal(result.stderrBytes, Buffer.byteLength('private diagnostic text'));
  assert.ok(result.stdoutBytes > 0);
  assert.ok(lines.every((line) => !line.includes('WAIT_HARNESS') && !line.includes('private diagnostic text')));
});

test('five projects can run at the same time', async () => {
  const server = await startRelay();
  for (const project of ['gamma', 'delta', 'epsilon']) mkdirSync(path.join(server.projectsDir, project));
  for (const project of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    await importMuse(server, `@opencode /new $${project} waiting WAIT_HARNESS`, `cap-${project}`);
  }
  await waitForRunCount(server, 5);
  assert.equal((await outbox(server)).length, 5);
  const waiting = await (await fetch(server.base + '/api/relay')).json();
  assert.equal(waiting.pending, 5);
  assert.equal(waiting.running, true);
  writeFileSync(path.join(server.harnessDir, 'release'), '');
});

function selectAlpha(reply: string): string {
  const match = reply.match(/@opencode \/select ([a-f0-9]{12}) \$<project>/);
  assert.ok(match, reply);
  return `@opencode /select ${match[1]} $alpha`;
}

test('an ambiguous task supersedes an older choice and keeps its original wording', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode first task', 'first-choice');
  const stale = selectAlpha((await outbox(server))[0].text);
  const task = 'Compare alpha and beta';
  await importMuse(server, '@opencode ' + task, 'ambiguous');
  const reply = (await outbox(server))[1].text;
  assert.match(reply, /names more than one project/);
  await importMuse(server, stale, 'stale-choice');
  assert.match((await outbox(server))[2].text, /no longer active/);
  assert.equal(runs(server).length, 0);
  await importMuse(server, selectAlpha(reply), 'current-choice');
  assert.equal(runs(server).length, 0);
  await importMuse(server, `@opencode /new $alpha compare ${task}`, 'current-choice-task');
  await waitForRunCount(server, 1);
  assert.equal(runs(server)[0].prompt, task);
});

test('unknown and removed projects get choices without running the harness', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode $missing build it', 'missing-project');
  const reply = (await outbox(server))[0].text;
  assert.match(reply, /project "missing" is unavailable/i);
  assert.match(reply, /- \$beta/);
  const selection = selectAlpha(reply);
  rmSync(server.alpha, { recursive: true });
  await importMuse(server, selection, 'removed-project');
  const retry = (await outbox(server))[1].text;
  assert.match(retry, /Choose an available project ID/);
  assert.doesNotMatch(retry, /- \$alpha/);
  assert.equal(runs(server).length, 0);
  await importMuse(server, selection.replace('$alpha', '$beta'), 'valid-project');
  assert.equal(runs(server).length, 0);
  await importMuse(server, '@opencode /new $beta build build it', 'valid-project-task');
  await waitForRunCount(server, 1);
  assert.equal(runs(server)[0].cwd, path.join(server.projectsDir, 'beta'));
  assert.equal(runs(server)[0].prompt, 'build it');
});

test('Muse creates a project from an empty list and resumes the saved task once', async () => {
  const server = await startRelay();
  rmSync(server.alpha, { recursive: true });
  rmSync(path.join(server.projectsDir, 'beta'), { recursive: true });
  await importMuse(server, '@opencode $missing build it', 'empty-projects');
  const reply = (await outbox(server))[0].text;
  assert.match(reply, /No projects are available/);
  assert.ok(reply.includes('@opencode /new-project <name>'));

  for (const [index, name] of ['../escape', 'alpha@opencode'].entries()) {
    await importMuse(server, `@opencode /new-project ${name}`, `invalid-project-${index}`);
    assert.match((await outbox(server)).at(-1)?.text ?? '', /Enter one project name/);
  }
  assert.deepEqual(readdirSync(server.projectsDir), []);
  await importMuse(server, '@opencode /new-project alpha', 'create-alpha');
  const created = (await outbox(server)).at(-1)?.text ?? '';
  assert.ok(created.includes('Project created. Project ID: $alpha.'));
  const selection = created.match(/@opencode \/select [a-f0-9]{12} \$alpha/)?.[0];
  assert.ok(selection);
  assert.equal(runs(server).length, 0);
  await importMuse(server, selection, 'select-created-alpha');
  assert.equal(runs(server).length, 0);
  await importMuse(server, '@opencode /new $alpha build build it', 'select-created-alpha-task');
  await waitForRunCount(server, 1);
  assert.equal(runs(server)[0].cwd, server.alpha);
  assert.equal(runs(server)[0].prompt, 'build it');
  const deadline = Date.now() + 5000;
  let replies = await outbox(server);
  while (!replies.some(({ text }) => text.includes('harness reply: build it')) && Date.now() < deadline) {
    await sleep(25);
    replies = await outbox(server);
  }
  assert.match(replies.at(-1)?.text ?? '', /harness reply: build it/);

  const file = path.join(server.alpha, 'hello.txt');
  writeFileSync(file, 'keep this file');
  const repliesBeforeReplay = (await outbox(server)).length;
  await importMuse(server, '@opencode /new-project alpha', 'create-alpha');
  assert.equal((await outbox(server)).length, repliesBeforeReplay);
  await importMuse(server, '@opencode /new-project alpha', 'rescanned-create-alpha');
  assert.match((await outbox(server)).at(-1)?.text ?? '', /already exists/);
  assert.deepEqual(readdirSync(server.projectsDir), ['alpha']);
  assert.equal(readFileSync(file, 'utf8'), 'keep this file');
  assert.equal(runs(server).length, 1);
});

test('the picker API creates projects and reports invalid names, conflicts, and write failures', async () => {
  const server = await startRelay();
  const create = (name: string): Promise<Response> => fetch(server.base + '/api/relay/projects/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  for (const name of ['../escape', '/tmp/escape', 'nested\\escape', 'NUL.txt', 'alpha.', '.hidden', 'alpha\n']) {
    assert.equal((await create(name)).status, 400, name);
  }
  writeFileSync(path.join(server.projectsDir, 'existing'), 'keep');
  assert.equal((await create('existing')).status, 409);
  assert.equal((await create('alpha')).status, 409);
  const response = await create('New project');
  assert.equal(response.status, 201);
  const result = await response.json() as { token: string; relay: { projects: Array<{ name: string; token: string }> } };
  assert.equal(result.token, 'new-project');
  assert.ok(result.relay.projects.some(({ name, token }) => name === 'New project' && token === result.token));
  assert.deepEqual(readdirSync(path.join(server.projectsDir, 'New project')), []);
  assert.equal(readFileSync(path.join(server.projectsDir, 'existing'), 'utf8'), 'keep');
  rmSync(server.projectsDir, { recursive: true });
  assert.equal((await create('unavailable')).status, 500);
});

test('a clear makes an unanswered project choice stale', async () => {
  const server = await startRelay();
  await importMuse(server, '@opencode build it', 'before-clear');
  const selection = selectAlpha((await outbox(server))[0].text);
  await importMuse(server, '/clear', 'clear', 'user');
  await importMuse(server, selection, 'after-clear');
  assert.match((await outbox(server))[1].text, /no longer active/);
  assert.equal(runs(server).length, 0);
});

test('project replies and the introduction use the same task format', () => {
  const options = { mention: '@opencode', root: '/Users/test/Projects', requestId: 'abc123' };
  const choices = buildProjectChoices(['/Users/test/Projects/alpha']);
  const projectList = formatProjectList(choices, options);
  assert.match(projectList, /Pick a project for your task:/);
  assert.match(projectList, /- \$alpha/);
  assert.ok(projectList.includes('@opencode /new $<project> <name> <task>'));
  assert.ok(projectList.includes('@opencode /select abc123 $<project>'));
  const intro = introMessage([{ id: 'opencode', name: 'OpenCode', enabled: true }]);
  assert.match(intro, /blibs is a desktop control panel/);
  assert.match(intro, /sends that task to OpenCode/);
  assert.ok(intro.includes('@opencode /new $<project> <name> <task>'));
  assert.ok(intro.includes('@opencode /select <request-id> $<project>'));
});

test('the default relay model uses the personal Beam Free provider', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blibs-relay-config-'));
  try { assert.equal(buildRelayConfig(dir).model, DEFAULT_RELAY_MODEL); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('relay settings reject invalid folders and keep the previous settings when persistence fails', async () => {
  const server = await startRelay();
  const post = (route: string, body: unknown) => fetch(server.base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const readStatus = async () => await (await fetch(server.base + '/api/relay')).json() as {
    discoveryRoot: string;
    harnesses: Array<{ id: string; name: string; enabled: boolean }>;
  };
  const blocked = path.join(server.dataDir, 'relay-state.json.tmp');
  const file = path.join(server.projectsDir, 'file.txt');
  writeFileSync(file, '');
  assert.equal((await post('/api/relay/projects', { discoveryRoot: file })).status, 400);

  mkdirSync(blocked);
  assert.equal((await post('/api/relay/projects', { discoveryRoot: server.alpha })).status, 500);
  const opencode = { id: 'opencode', name: 'OpenCode', enabled: false };
  assert.equal((await post('/api/relay/harnesses', { harnesses: [opencode] })).status, 500);
  assert.equal((await readStatus()).discoveryRoot, server.projectsDir);
  assert.deepEqual((await readStatus()).harnesses, [{ ...opencode, enabled: true }]);
  rmSync(blocked, { recursive: true });

  assert.equal((await post('/api/relay/harnesses', { harnesses: [opencode] })).status, 200);
  assert.equal((await post('/api/relay/harnesses', {
    harnesses: [{ id: 'codex', name: 'Codex', enabled: true }],
  })).status, 200);
  assert.deepEqual((await readStatus()).harnesses, [opencode]);
  await importMuse(server, '@opencode /new $alpha greeting hello', 'settings-disabled');
  assert.ok((await outbox(server)).some((item) => item.text.includes('OpenCode harness is disabled')));
  assert.equal(runs(server).length, 0);
});
