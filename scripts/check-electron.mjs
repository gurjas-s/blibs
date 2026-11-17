import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Electron's installer can finish without errors while leaving only
// dist/LICENSES.chromium.html behind (for example on newer Node releases).
// Fail at install/start time with a fix instead of exposing the binary later.

const root = fileURLToPath(new URL('..', import.meta.url));
const electronDir = path.join(root, 'node_modules', 'electron');
let platformPath = '';
try {
  platformPath = readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
} catch { /* reported below */ }
const binary = platformPath ? path.join(electronDir, 'dist', platformPath) : '';

if (!platformPath || !existsSync(binary)) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const lines = [
    '',
    '[blibs] Electron is not installed correctly.',
    `        Current Node.js: ${process.version}. blibs requires Node.js 24.x.`,
    '        Electron 34 does not install its binary on newer Node.js releases.',
  ];
  if (nodeMajor >= 25) {
    lines.push('        Switch to Node.js 24 and reinstall:');
    lines.push('          fnm use 24 && npm ci      # or: nvm use 24 && npm ci');
  } else {
    lines.push('        Reinstall the dependencies:');
    lines.push('          npm ci');
  }
  lines.push('        Then run npm start again.');
  console.error(lines.join('\n'));
  process.exit(1);
}
