import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/provision-env.mjs', import.meta.url));
const secretValue = 'BLIBS_TEST_SECRET=S3CRET-value-do-not-print\n';

interface RunOptions {
  secretsDir: string;
  home: string;
  source?: string;
  require?: boolean;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function makeRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'blibs-provision-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=blibs test',
      '-c',
      'user.email=blibs@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function makeRepo(t: TestContext): { root: string; main: string; repo: string } {
  const root = makeRoot(t);
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, ['init', '-q']);
  writeFileSync(join(main, 'README.md'), '# test repository\n');
  git(main, ['add', 'README.md']);
  git(main, ['commit', '-qm', 'Initial commit']);
  return { root, main, repo: basename(main) };
}

function writeSecret(secretsDir: string, repo: string, contents = secretValue): string {
  const directory = join(secretsDir, repo);
  mkdirSync(directory, { recursive: true });
  const source = join(directory, '.env');
  writeFileSync(source, contents);
  return source;
}

function run(cwd: string, options: RunOptions, args: string[] = []): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: options.home,
    USERPROFILE: options.home,
    SECRETS_DIR: options.secretsDir,
  };
  delete env.BLIBS_ENV_SOURCE;
  delete env.BLIBS_REQUIRE_ENV;
  if (options.source !== undefined) env.BLIBS_ENV_SOURCE = options.source;
  if (options.require) env.BLIBS_REQUIRE_ENV = '1';

  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function options(root: string): RunOptions {
  return {
    secretsDir: join(root, 'secrets'),
    home: join(root, 'home'),
  };
}

test('copies the secrets file when .env is missing', (t) => {
  const { root, main, repo } = makeRepo(t);
  const source = writeSecret(join(root, 'secrets'), repo);

  const result = run(main, options(root));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(main, '.env'), 'utf8'), secretValue);
  assert.match(result.stdout, /copied/);
  assert.ok(result.stdout.includes(source), 'the success line names the source path');
  assert.ok(result.stdout.includes(join(main, '.env')), 'the success line names the destination path');
  assert.equal(git(main, ['status', '--porcelain']), '', 'the copied .env stays out of git status');
});

test('does not overwrite an existing .env', (t) => {
  const { root, main, repo } = makeRepo(t);
  writeSecret(join(root, 'secrets'), repo);
  writeFileSync(join(main, '.env'), 'EXISTING=keep-this\n');

  const result = run(main, options(root));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(main, '.env'), 'utf8'), 'EXISTING=keep-this\n');
  assert.match(result.stdout, /kept existing/);
  assert.doesNotMatch(result.stdout, /copied/);
});

test('does not replace a symlink at the destination', { skip: process.platform === 'win32' }, (t) => {
  const { root, main, repo } = makeRepo(t);
  writeSecret(join(root, 'secrets'), repo);
  const target = join(root, 'target.env');
  writeFileSync(target, 'TARGET=unchanged\n');
  symlinkSync(target, join(main, '.env'));

  const result = run(main, options(root));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept existing/);
  assert.equal(readFileSync(target, 'utf8'), 'TARGET=unchanged\n');
});

test('sets mode 0600 on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const { root, main, repo } = makeRepo(t);
  writeSecret(join(root, 'secrets'), repo);

  const result = run(main, options(root));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(join(main, '.env')).mode & 0o777, 0o600);
});

test('warns on a missing source and exits 0 by default', (t) => {
  const { root, main } = makeRepo(t);

  const result = run(main, options(root));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning/);
  assert.match(result.stderr, /no \.env source found/);
  assert.equal(existsSync(join(main, '.env')), false);
});

test('fails on a missing source when BLIBS_REQUIRE_ENV=1', (t) => {
  const { root, main } = makeRepo(t);

  const result = run(main, { ...options(root), require: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLIBS_REQUIRE_ENV=1/);
  assert.equal(existsSync(join(main, '.env')), false);
});

test('--check reports the destination and does not write', (t) => {
  const { root, main } = makeRepo(t);
  const destination = join(main, '.env');

  const missing = run(main, options(root), ['--check']);

  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /missing/);
  assert.equal(existsSync(destination), false);

  writeFileSync(destination, 'EXISTING=unchanged\n');
  const present = run(main, options(root), ['--check']);

  assert.equal(present.status, 0);
  assert.match(present.stdout, /exists/);
  assert.equal(readFileSync(destination, 'utf8'), 'EXISTING=unchanged\n');
});

test('--check does not create the info/exclude entry', (t) => {
  const { root, main } = makeRepo(t);

  run(main, options(root), ['--check']);

  const exclude = join(main, '.git', 'info', 'exclude');
  const contents = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  assert.doesNotMatch(contents, /^\.env$/m);
});

test('resolves the repository name from a linked worktree', (t) => {
  const { root, main, repo } = makeRepo(t);
  const worktree = join(root, 'linked');
  git(main, ['worktree', 'add', '-q', worktree, 'HEAD']);
  writeSecret(join(root, 'secrets'), repo, 'FROM_MAIN_CHECKOUT=1\n');
  writeSecret(join(root, 'secrets'), basename(worktree), 'FROM_WORKTREE_NAME=0\n');

  const result = run(worktree, options(root));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'FROM_MAIN_CHECKOUT=1\n');
  assert.match(result.stdout, /copied/);
});

test('falls back to the main checkout .env in a linked worktree', (t) => {
  const { root, main } = makeRepo(t);
  const worktree = join(root, 'linked');
  git(main, ['worktree', 'add', '-q', worktree, 'HEAD']);
  writeFileSync(join(main, '.env'), 'FROM_CHECKOUT=1\n');

  const result = run(worktree, options(root));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'FROM_CHECKOUT=1\n');
});

test('uses BLIBS_ENV_SOURCE before the secrets directory', (t) => {
  const { root, main, repo } = makeRepo(t);
  writeSecret(join(root, 'secrets'), repo, 'FROM_SECRETS=1\n');
  const explicit = join(root, 'explicit.env');
  writeFileSync(explicit, 'FROM_EXPLICIT=1\n');

  const result = run(main, { ...options(root), source: explicit });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(main, '.env'), 'utf8'), 'FROM_EXPLICIT=1\n');
});

test('never prints secret values', (t) => {
  const { root, main, repo } = makeRepo(t);
  writeSecret(join(root, 'secrets'), repo);

  const copied = run(main, options(root));
  assert.equal(copied.status, 0, copied.stderr);
  assert.ok(!copied.stdout.includes('S3CRET-value-do-not-print'));
  assert.ok(!copied.stderr.includes('S3CRET-value-do-not-print'));

  rmSync(join(main, '.env'));
  rmSync(join(root, 'secrets'), { recursive: true, force: true });
  const missing = run(main, options(root));
  assert.equal(missing.status, 0, missing.stderr);
  assert.ok(!missing.stdout.includes('S3CRET-value-do-not-print'));
  assert.ok(!missing.stderr.includes('S3CRET-value-do-not-print'));
});
