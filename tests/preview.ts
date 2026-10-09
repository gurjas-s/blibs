// Browser fixture: the real panel and backend with disposable data and a fake
// desktop bridge. Never loads vendor accounts or sends to an external service.
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProxyServer } from '../server/proxy.ts';
import type { VendorSession } from '../src/renderer/types.ts';

const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-preview-'));
const backend = createProxyServer(dataDir);
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');
const address = backend.address();
if (!address || typeof address === 'string') throw new Error('No backend port.');
const base = `http://127.0.0.1:${address.port}`;
const now = Date.now();
const sessions: VendorSession[] = [
  { provider: 'muse', state: 'ready', reason: 'Signed in. Chats sync automatically.', updatedAt: now, lastSyncAt: now },
  { provider: 'dots', state: 'signed-out', reason: 'Sign in to sync your chats.', updatedAt: now, lastSyncAt: null },
  { provider: 'grok', state: 'error', reason: 'Could not reach Grok. Try opening the agent again.', updatedAt: now, lastSyncAt: null },
];
if (!process.argv.includes('--fresh')) await fetch(base + '/api/import', {
  method: 'POST', body: JSON.stringify({ items: Array.from({ length: 14 }, (_, index) => ({
    provider: 'muse', role: index % 3 ? 'agent' : 'user', ts: now - (14 - index) * 90000,
    text: index === 13 ? 'Here is the example:\n```js\n  const message = "Hello";\n  console.log(message);\n```\nThe indentation stays intact.' : `Preview message ${index + 1}. This is a sample conversation for checking scrolling and message layout.`,
  })) }),
});
let failNextQueue = true;
const bridge = `<script>window.blibs={sessions:()=>fetch('/test/sessions').then(r=>r.json()),signIn:provider=>fetch('/test/sign-in',{method:'POST',body:JSON.stringify({provider})}).then(r=>r.json())};</script>`;
const panel = http.createServer((request, response) => {
  void (async () => {
    const url = request.url || '/';
    if (url === '/test/sessions') {
      response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify(sessions));
    }
    if (url === '/test/sign-in') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { provider } = JSON.parse(body);
      const session = sessions.find((item) => item.provider === provider);
      if (session) { session.state = 'ready'; session.reason = 'Signed in. Chats sync automatically.'; }
      await fetch(base + '/api/import', { method: 'POST', body: JSON.stringify({ items: [{ provider, role: 'agent', text: 'Welcome! Your first chat is synced.', ts: Date.now() }] }) });
      response.setHeader('Content-Type', 'application/json');
      return response.end('{"ok":true}');
    }
    if (url.startsWith('/api/')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (url === '/api/outbox' && request.method === 'POST' && failNextQueue) {
        failNextQueue = false;
        response.writeHead(503, { 'Content-Type': 'application/json' });
        return response.end('{"error":"Temporary queue failure."}');
      }
      const upstream = await fetch(base + url, { method: request.method, body: body || undefined });
      const text = await upstream.text();
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      response.end(text);
      if ((url === '/api/outbox' || url === '/api/outbox/retry') && request.method === 'POST') {
        const { id } = JSON.parse(text);
        if (id) setTimeout(() => { void fetch(base + '/api/outbox/ack', { method: 'POST', body: JSON.stringify({ id, ok: true }) }); }, 3000);
      }
      return;
    }
    const filename = url === '/' ? 'index.html' : url.split('?')[0].slice(1);
    const file = path.resolve('dist', filename);
    if (!file.startsWith(path.resolve('dist') + path.sep)) { response.writeHead(403); return response.end(); }
    const contents = readFileSync(file);
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/svg+xml');
    response.end(file.endsWith('.html') ? contents.toString().replace('<head>', '<head>' + bridge) : contents);
  })().catch(() => { response.writeHead(500); response.end(); });
});
panel.listen(15175, '127.0.0.1', () => console.log('Preview at http://127.0.0.1:15175'));
function stop() { panel.close(); backend.close(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(0); }); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
