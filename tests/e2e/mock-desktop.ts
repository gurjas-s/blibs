import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch } from './harness.js';

const app = await launch();
const stop = new AbortController();
const requestStop = () => stop.abort();
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

try {
  const disconnected = once(app.browser, 'disconnected', { signal: stop.signal });
  const session = disconnected.catch((error: unknown) => {
    if (!stop.signal.aborted) throw error;
  });

  await Promise.all(['alpha', 'beta'].map((name) => mkdir(path.join(app.projectsDir, name))));
  console.log(`Panel: ${app.panelUrl}
Backend: ${app.backendUrl}
DevTools: ${app.cdpUrl}
Quit blibs or press Ctrl+C to clean up this mock session.`);
  await session;
} finally {
  await app.close();
  process.removeListener('SIGINT', requestStop);
  process.removeListener('SIGTERM', requestStop);
}
