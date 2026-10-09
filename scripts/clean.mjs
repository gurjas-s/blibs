import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Remove only generated output. Keep TypeScript's incremental state so the
// clean-build check can catch builds that skip emitting after output is deleted.
for (const directory of ['build', 'dist']) {
  rmSync(fileURLToPath(new URL(`../${directory}`, import.meta.url)), { recursive: true, force: true });
}
