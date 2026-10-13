import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HistoryStore, sourceUrl, chunks, copyIfAbsent } from '../server/history.ts';
import { createProxyServer } from '../server/proxy.ts';
import { once } from 'node:events';
import { RetrievalService, localEndpoint, validateClaims } from '../server/retrieval.ts';
import type { Passage } from '../server/history.ts';

const item = { provider: 'dots', role: 'agent', text: 'Atlas uses SQLite for local storage.', ts: 10, url: 'https://chatgpt.com/c/atlas', sourceId: 'm1' };
function temp() { return mkdtempSync(path.join(tmpdir(), 'blibs-history-')); }
test('migration preserves duplicate legacy rows, backup bytes, and restart idempotency', () => {
  const dir = temp(); const legacy = [{ ...item, sourceId: undefined }, { ...item, sourceId: undefined }, { invalid: true }];
  const raw = JSON.stringify(legacy); writeFileSync(path.join(dir, 'imports.json'), raw);
  let store = new HistoryStore(dir);
  assert.equal(store.count(), 2); assert.match(store.migrationWarning, /1 invalid/);
  assert.equal(readFileSync(path.join(dir, 'imports.json'), 'utf8'), raw);
  assert.equal(readFileSync(path.join(dir, 'imports.pre-sqlite.json'), 'utf8'), raw);
  store.close(); store = new HistoryStore(dir); assert.equal(store.count(), 2); store.close(); rmSync(dir, { recursive: true });
});
test('corrupt migration retries after repair without deleting original data', () => {
  const dir = temp(); writeFileSync(path.join(dir, 'imports.json'), '{');
  let store = new HistoryStore(dir); assert.equal(store.count(), 0); assert.match(store.migrationWarning, /pending/); store.close();
  writeFileSync(path.join(dir, 'imports.json'), JSON.stringify([item])); store = new HistoryStore(dir); assert.equal(store.count(), 1); store.close(); rmSync(dir, { recursive: true });
});
test('unsupported future schema fails without relabeling or adding tables', () => {
  const dir = temp(), file = path.join(dir, 'history.sqlite'); const db = new DatabaseSync(file); db.exec('PRAGMA user_version=9; CREATE TABLE future(value TEXT)'); db.close();
  const before = readFileSync(file); assert.throws(() => new HistoryStore(dir), /newer than supported/); assert.deepEqual(readFileSync(file), before); rmSync(dir, { recursive: true });
});
test('source identity preserves real repeats, updates streaming text, namespaces threads and retains first observation', () => {
  const dir = temp(), store = new HistoryStore(dir);
  assert.equal(store.import([item, { ...item, sourceId: 'm2' }, { ...item, url: 'https://chatgpt.com/c/beta' }]).added, 3);
  assert.equal(store.import([item, { ...item, sourceId: 'm2', ts: 99 }]).added, 0);
  assert.equal(store.import([{ ...item, text: 'Atlas uses PostgreSQL after the revision.' }]).updated, 1);
  assert.equal(store.list().find(m => m.sourceId === 'm2')!.ts, 10);
  assert.equal(store.keyword('SQLite').length, 2); assert.equal(store.keyword('PostgreSQL').length, 1);
  store.close(); rmSync(dir, { recursive: true });
});
test('rendered-position reuse preserves changed content when history is virtualized', () => {
  const dir = temp(), store = new HistoryStore(dir);
  store.import([{ ...item, sourceId: 'rendered:agent:0', identity: 'rendered-position' }]);
  store.import([{ ...item, sourceId: 'rendered:agent:0', identity: 'rendered-position', text: 'A different visible message.' }]);
  assert.equal(store.count(), 2); assert.equal(store.list()[0].identity, 'rendered-position');
  store.close(); rmSync(dir, { recursive: true });
});
test('keyword filters, pagination, bounded chunks, and whole retained history exceed old cap', () => {
  const dir = temp(), store = new HistoryStore(dir);
  store.import(Array.from({ length: 2200 }, (_, n) => ({ ...item, sourceId: `m${n}`, ts: n, text: `Decision ${n}: Atlas stores records in SQLite.` })));
  assert.equal(store.count(), 2200); assert.equal(store.list(100, 2100).length, 100);
  assert.equal(store.keyword('SQLite', { from: 2195, to: 2199 }).length, 5); assert.equal(store.keyword('SQLite', { provider: 'grok' }).length, 0);
  assert.ok(chunks('x'.repeat(32000)).every(c => c.length <= 1000));
  store.close(); rmSync(dir, { recursive: true });
});
test('vector version mismatch becomes pending, rebuild clears only derived data, and edits invalidate vector', () => {
  const dir = temp(), store = new HistoryStore(dir); store.import([item]); const p = store.pending('v1')[0];
  store.saveVector(p.id, p.contentHash, 'v1', Array(384).fill(0.1)); assert.equal(store.pending('v1').length, 0); assert.equal(store.pending('v2').length, 1);
  store.import([{ ...item, text: 'Updated decision.' }]); assert.equal(store.pending('v1').length, 1);
  store.rebuild(); assert.equal(store.count(), 1); store.close(); rmSync(dir, { recursive: true });
});
test('unavailable models degrade to keyword results and abstain without affecting history', async () => {
  const dir = temp(), store = new HistoryStore(dir); store.import([item]); const service = new RetrievalService(store, { embeddingUrl: 'http://127.0.0.1:1' });
  const search = await service.search('Atlas storage'); assert.equal(search.mode, 'keyword'); assert.equal(search.results.length, 1); assert.match(search.warning, /unavailable/);
  await service.startIndex(); assert.match(service.indexError, /fetch failed/); assert.equal(store.pending(service.model).length, 1);
  const answer = await service.ask('Atlas storage'); assert.equal(answer.abstained, true); assert.equal(answer.claims.length, 0); await service.close(); rmSync(dir, { recursive: true });
});
test('citation validation rejects invented claim wording and unknown source identifiers', () => {
  const source = { ...item, id: 's1', threadId: 'atlas', identity: 'source-id', chunkId: 1, snippet: item.text, score: 1 } as Passage;
  assert.equal(validateClaims({ claims: [{ text: 'Atlas uses Redis.', quote: item.text, sourceId: 's1' }] }, [source]).length, 0);
  assert.equal(validateClaims({ claims: [{ text: item.text, quote: item.text, sourceId: 'unknown' }] }, [source]).length, 0);
  assert.equal(validateClaims({ claims: [{ text: item.text, quote: item.text, sourceId: 's1' }] }, [source]).length, 1);
});
test('source navigation rejects credentials, active schemes, lookalike hosts and query secrets', () => {
  assert.equal(sourceUrl('dots', 'javascript:alert(1)'), ''); assert.equal(sourceUrl('dots', 'https://chatgpt.com.evil/c/a'), '');
  assert.equal(sourceUrl('dots', 'https://user:secret@chatgpt.com/c/a'), ''); assert.equal(sourceUrl('dots', 'https://chatgpt.com/c/a?token=secret#frag'), 'https://chatgpt.com/c/a');
  assert.throws(() => localEndpoint('https://api.example.com'), /127.0.0.1/); assert.throws(() => localEndpoint('http://localhost:80'), /127.0.0.1/);
});

test('an empty startup index can later index imports; repeated resume and cancellation remain restartable', async () => {
  const dir = temp(), store = new HistoryStore(dir); const service = new RetrievalService(store, { embeddingUrl: 'http://127.0.0.1:1', embeddingModel: 'test-v1' });
  service.embed = async input => input.map(() => Array(384).fill(0.1));
  await service.startIndex(); await service.startIndex(); assert.equal(service.status().running, false);
  store.import([item]); await service.startIndex(); assert.equal(Number(service.status().indexed), 1);
  store.import([{ ...item, sourceId: 'm2' }]);
  service.embed = async (_input, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const indexing = service.startIndex(); await new Promise<void>(resolve => setImmediate(resolve)); await service.cancel(); await indexing;
  assert.equal(store.pending('test-v1').length, 1); await service.close();
  const restarted = new HistoryStore(dir); assert.equal(restarted.pending('test-v1').length, 1); restarted.close(); rmSync(dir, { recursive: true });
});

test('search paging reaches past 200 retained messages and chooses one chunk per message', async () => {
  const dir = temp(), store = new HistoryStore(dir); store.import(Array.from({ length: 260 }, (_, n) => ({ ...item, sourceId: `page-${n}`, text: 'Atlas storage SQLite. '.repeat(80) })));
  const service = new RetrievalService(store); const page = await service.search('Atlas SQLite', {}, 'keyword', 10, 240);
  assert.equal(page.results.length, 10); assert.equal(new Set(page.results.map(r => r.id)).size, 10); assert.equal(page.hasMore, true); await service.close(); rmSync(dir, { recursive: true });
});

test('migration transaction failure rolls back all rows and retries after repair', () => {
  const dir = temp(); let store = new HistoryStore(dir);
  store.db.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON messages WHEN new.text='explode' BEGIN SELECT RAISE(ABORT,'simulated failure'); END"); store.close();
  writeFileSync(path.join(dir, 'imports.json'), JSON.stringify([item, { ...item, sourceId: 'm2', text: 'explode' }]));
  store = new HistoryStore(dir); assert.equal(store.count(), 0); assert.match(store.migrationWarning, /pending/); store.db.exec('DROP TRIGGER fail_migration'); store.close();
  store = new HistoryStore(dir); assert.equal(store.count(), 2); store.close(); rmSync(dir, { recursive: true });
});

test('durable-path migration preserves imports/outbox bytes and recovers interrupted staging on restart', async () => {
  const legacy = temp(), durable = temp();
  const imported = JSON.stringify([item]); const outbox = JSON.stringify([{ id: 'queued-before-upgrade', provider: 'dots', text: 'preserve pending delivery', ts: 10, status: 'queued', attempts: 0 }]);
  writeFileSync(path.join(legacy, 'imports.json'), imported); writeFileSync(path.join(legacy, 'outbox.json'), outbox);
  writeFileSync(path.join(durable, 'imports.json.pending'), '{interrupted'); writeFileSync(path.join(durable, 'outbox.json.pending'), '{interrupted');
  const previous = process.env.BLIBS_LEGACY_DIR; process.env.BLIBS_LEGACY_DIR = legacy;
  let server;
  try {
    server = createProxyServer(durable); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); const base = `http://127.0.0.1:${addr.port}`;
    const imports = await fetch(base + '/api/imports').then(r => r.json()); assert.equal(imports.imports.length, 1);
    const pending = await fetch(base + '/api/outbox/pending').then(r => r.json()); assert.equal(pending.items[0].id, 'queued-before-upgrade');
    assert.equal(readFileSync(path.join(legacy, 'imports.json'), 'utf8'), imported); assert.equal(readFileSync(path.join(legacy, 'outbox.json'), 'utf8'), outbox);
    assert.equal(readFileSync(path.join(durable, 'outbox.json'), 'utf8'), outbox);
    await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    writeFileSync(path.join(legacy, 'outbox.json'), '[]'); copyIfAbsent(path.join(legacy, 'outbox.json'), path.join(durable, 'outbox.json'));
    assert.equal(readFileSync(path.join(durable, 'outbox.json'), 'utf8'), outbox);
    const restarted = new HistoryStore(durable); assert.equal(restarted.count(), 1); restarted.close();
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (previous === undefined) delete process.env.BLIBS_LEGACY_DIR; else process.env.BLIBS_LEGACY_DIR = previous;
    rmSync(legacy, { recursive: true }); rmSync(durable, { recursive: true });
  }
});
