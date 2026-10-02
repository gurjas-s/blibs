// The repo root is `"type": "module"` (renderer + backend are ESM), but the
// Electron main process and preload scripts compile to CommonJS. Node (and
// Electron's own `import()` of the app entry) resolves `.js` vs `.cjs` via the
// nearest package.json — so these markers make everything under
// build/main/ and build/preload/ unambiguously CommonJS, while
// build/server/ stays ESM under the root package.json.
//
// Regenerated on every `npm run build`; wiped by `npm run clean`.
import { mkdirSync, writeFileSync } from 'node:fs';

for (const dir of ['build/main', 'build/preload']) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify({ type: 'commonjs' }) + '\n');
}
console.log('wrote build/main/package.json + build/preload/package.json (type: commonjs)');
