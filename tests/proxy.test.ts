import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createProxyServer } from '../server/proxy.ts';
import http from 'node:http';

const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-routes-'));
const server = createProxyServer(dataDir, {}, { relay: { enabled: false } });
let base: string;
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

async function post(route: string, body: unknown) {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

test('legacy imports deduplicate exact provider/thread/role/timestamp/text observations and survive restart', async () => {
  const item = { provider: 'dots', role: 'agent', text: 'hello', ts: 123, url: 'https://chatgpt.com/c/test' };
  assert.equal((await post('/api/import', { items: [item, item] })).data.added, 1);
  assert.equal((await post('/api/import', { items: [item] })).data.added, 0);
  assert.equal((await post('/api/import', { items: [{ ...item, role: 'user' }, { ...item, provider: 'grok' }] })).data.added, 2);
  const stored = await fetch(base + '/api/imports').then((response) => response.json());
  assert.equal(stored.imports.length, 3);
  const matched = stored.imports.find((m: typeof item) => m.provider === item.provider && m.role === item.role);
  assert.deepEqual(Object.fromEntries(Object.keys(item).map(key => [key, matched[key]])), item);

  const restarted = createProxyServer(dataDir, {}, { relay: { enabled: false } });
  restarted.listen(0, '127.0.0.1');
  await once(restarted, 'listening');
  try {
    const address = restarted.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/import`, {
      method: 'POST', body: JSON.stringify({ items: [item] }),
    });
    assert.equal((await response.json()).added, 0);
  } finally {
    await new Promise<void>((resolve) => restarted.close(() => resolve()));
  }
});

test('outbox queues, reports failure, retries, and records delivery', async () => {
  const queued = await post('/api/outbox', { provider: 'muse', text: 'send this' });
  assert.equal(queued.status, 200);
  const id = queued.data.id;
  let pending = await fetch(base + '/api/outbox/pending').then((response) => response.json());
  assert.equal(pending.items[0].id, id);
  assert.equal((await post('/api/outbox/ack', { id, ok: false, error: 'Sign in first.' })).data.status, 'failed');
  pending = await fetch(base + '/api/outbox/pending').then((response) => response.json());
  assert.equal(pending.items.length, 0);
  assert.equal((await post('/api/outbox/retry', { id })).data.status, 'queued');
  assert.equal((await post('/api/outbox/ack', { id, ok: true })).data.status, 'sent');
  const statuses = await fetch(base + '/api/outbox').then((response) => response.json());
  assert.equal(statuses.items[0].attempts, 2);
  assert.equal(statuses.items[0].error, undefined);
  assert.ok(statuses.items[0].sentAt);
});

test('invalid requests return actionable HTTP errors', async () => {
  assert.equal((await post('/api/outbox', { text: '  ' })).status, 400);
  assert.equal((await post('/api/outbox/ack', { id: 'missing' })).status, 404);
  assert.equal((await post('/api/outbox/retry', { id: 'missing' })).status, 404);
  const invalid = await fetch(base + '/api/import', { method: 'POST', body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid JSON');
  assert.equal((await fetch(base + '/missing')).status, 404);
});

test('expanded history APIs reject external browser origins and DNS rebinding hosts', async () => {
  for (const route of ['/api/history', '/api/index', '/api/imports']) {
    const blocked = await fetch(base + route, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  }
  const rebound = await new Promise<number>(resolve => { http.get(base + '/api/history', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode!); }); });
  assert.equal(rebound, 403);
  const local = await fetch(base + '/api/history', { headers: { Origin: base } }); assert.equal(local.status, 200); assert.equal(local.headers.get('access-control-allow-origin'), base);
  const ask = await fetch(base + '/api/ask', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: JSON.stringify({ query: 'hello' }) }); assert.equal(ask.status, 403);
});
