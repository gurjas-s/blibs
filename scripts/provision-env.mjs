// Provision the machine-local .env file for a checkout.
//
// T3 creates a worktree with `git worktree add --no-checkout`, populates it
// from its checkout cache with `core.hooksPath=/dev/null`, and then runs
// `git hook run post-checkout` with an environment that does not resolve the
// global hook. The global post-checkout hook is not reliable for T3 worktrees.
// This checked-in script is the setup script in t3.json.
//
// Source order:
//   1. BLIBS_ENV_SOURCE when set.
//   2. <SECRETS_DIR>/<repo>/.env. SECRETS_DIR defaults to ~/.secrets.
//   3. The main checkout's own .env.
//
// The destination is .env at the checkout root. The script never overwrites an
// existing file, a symlink, or a directory. It never prints file contents.
//
// Exit codes:
//   0  The file exists, was copied, or no source was found.
//   1  BLIBS_REQUIRE_ENV=1 and no source was found, or --check found no file.
//
// Usage:
//   node scripts/provision-env.mjs
//   node scripts/provision-env.mjs --check

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const WINDOWS = process.platform === 'win32';
const checkOnly = process.argv.includes('--check');
const requireEnv = process.env.BLIBS_REQUIRE_ENV === '1';
const cwd = process.cwd();

function git(args, at) {
  return execFileSync('git', args, {
    cwd: at,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

function resolveCheckout() {
  const top = resolve(cwd, git(['rev-parse', '--show-toplevel'], cwd));
  const common = git(['rev-parse', '--git-common-dir'], cwd);
  const commonPath = isAbsolute(common) ? common : resolve(top, common);
  let mainRoot;
  try {
    // A linked worktree shares the main checkout's .git directory. Resolve
    // symlinks so the parent directory names the repository, like the global
    // hook does.
    mainRoot = realpathSync(commonPath);
  } catch {
    mainRoot = commonPath;
  }
  mainRoot = dirname(mainRoot);
  return {
    top,
    mainRoot,
    repo: basename(mainRoot),
    destination: join(top, '.env'),
  };
}

function sourceCandidates(mainRoot, repo) {
  const candidates = [];
  const explicit = process.env.BLIBS_ENV_SOURCE?.trim();
  if (explicit) candidates.push(resolve(cwd, expandHome(explicit)));

  const configured = process.env.SECRETS_DIR?.trim() || join(homedir(), '.secrets');
  candidates.push(join(resolve(cwd, expandHome(configured)), repo, '.env'));
  candidates.push(join(mainRoot, '.env'));

  return [...new Set(candidates)];
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function pathExists(path) {
  try {
    // lstat does not follow a symlink. A broken symlink still exists and must
    // not be replaced.
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function ensureIgnored(top) {
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', '.env'], {
      cwd: top,
      stdio: 'ignore',
    });
    ignored = true;
  } catch (error) {
    // Exit status 1 means that Git does not ignore the path yet. Any other
    // status is a real error.
    if (error.status !== 1) throw error;
  }
  if (ignored) return;

  const exclude = git(['rev-parse', '--git-path', 'info/exclude'], top);
  const excludePath = isAbsolute(exclude) ? exclude : resolve(top, exclude);
  mkdirSync(dirname(excludePath), { recursive: true });

  let prefix = '';
  try {
    const contents = readFileSync(excludePath, 'utf8');
    if (contents.length > 0 && !contents.endsWith('\n')) prefix = '\n';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  appendFileSync(excludePath, `${prefix}.env\n`);
}

function main() {
  const { top, mainRoot, repo, destination } = resolveCheckout();

  if (checkOnly) {
    if (pathExists(destination)) {
      console.log(`env: ${destination} exists`);
    } else {
      console.log(`env: ${destination} missing`);
      process.exitCode = 1;
    }
    return;
  }

  if (pathExists(destination)) {
    console.log(`env: kept existing ${destination}`);
    return;
  }

  const candidates = sourceCandidates(mainRoot, repo);
  const source = candidates.find(isRegularFile);
  if (!source) {
    const detail = `env: warning: no .env source found for ${repo}; tried ${candidates.join(', ')}.`;
    if (requireEnv) {
      console.error(`${detail} BLIBS_REQUIRE_ENV=1 is set.`);
      process.exitCode = 1;
      return;
    }
    console.error(`${detail} Set BLIBS_ENV_SOURCE, or create the secrets file.`);
    return;
  }

  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === 'EEXIST') {
      console.log(`env: kept existing ${destination}`);
      return;
    }
    throw error;
  }

  if (!WINDOWS) chmodSync(destination, 0o600);
  ensureIgnored(top);
  console.log(`env: copied ${source} -> ${destination}`);
}

main();
