import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createProxyServer } from '../server/proxy.ts';

const dataDir = mkdtempSync(path.join(tmpdir(), 'blibs-routes-'));
const server = createProxyServer(dataDir);
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

test('imports deduplicate by provider, role, and text and survive a server restart', async () => {
  const item = { provider: 'dots', role: 'agent', text: 'hello', ts: 123, url: 'https://chatgpt.com/c/test' };
  assert.equal((await post('/api/import', { items: [item, item] })).data.added, 1);
  assert.equal((await post('/api/import', { items: [item] })).data.added, 0);
  assert.equal((await post('/api/import', { items: [{ ...item, role: 'user' }, { ...item, provider: 'grok' }] })).data.added, 2);
  const stored = await fetch(base + '/api/imports').then((response) => response.json());
  assert.equal(stored.imports.length, 3);
  assert.deepEqual(stored.imports[0], item);

  const restarted = createProxyServer(dataDir);
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

test('a lost queue response can be retried without creating a second send', async () => {
  const body = { provider: 'dots', text: 'retry once', clientId: 'stable-client-id' };
  const first = await post('/api/outbox', body);
  const second = await post('/api/outbox', body);
  assert.equal(first.data.id, second.data.id);
  assert.equal((await post('/api/outbox', { ...body, text: 'different message' })).status, 409);
  await post('/api/outbox/ack', { id: first.data.id, ok: true });
  assert.equal((await post('/api/outbox', body)).data.status, 'sent');
  assert.equal((await post('/api/outbox/retry', { id: first.data.id })).status, 409);
});
