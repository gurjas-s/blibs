import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = mkdtempSync(path.join(tmpdir(), 'blibs-desktop-'));
const env = { ...process.env, BLIBS_TEST_DIR: directory, BLIBS_NODE_PATH: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
let child;
let timer;
try {
  child = spawn(require('electron'), [fileURLToPath(new URL('../tests/search-desktop.cjs', import.meta.url))], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  timer = setTimeout(() => { console.error('Desktop check timed out.'); child.kill(); }, 60000);
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  clearTimeout(timer);
  // Electron can release its Windows cache files shortly after it exits.
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
