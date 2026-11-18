import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './clean.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
assert.ok(process.env.npm_execpath, 'Run this check with npm run verify:clean-build.');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
assert.equal(result.status, 0, 'The build must succeed after generated output is removed.');
for (const file of ['build/main/index.js', 'build/preload/agent.js', 'build/server/proxy.js', 'build/server/history.js', 'build/server/retrieval.js', 'build/server/harness/opencode.js', 'dist/index.html']) {
  assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `The clean build did not regenerate ${file}.`);
}
for (const directory of ['main', 'preload']) {
  const marker = JSON.parse(readFileSync(new URL(`../build/${directory}/package.json`, import.meta.url), 'utf8'));
  assert.equal(marker.type, 'commonjs', `The ${directory} CommonJS marker is missing.`);
}
console.log('Clean build regenerated the app, preload, backend, panel, and CommonJS markers.');
