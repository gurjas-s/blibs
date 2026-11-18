import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface HistoryMessage {
  id: string; provider: string; role: string; text: string; ts: number; url: string;
  threadId: string; sourceId: string; identity: string;
}
export interface Passage extends HistoryMessage { chunkId: number; snippet: string; score: number; context?: HistoryMessage[] }
export interface SearchFilters { provider?: string; threadId?: string; from?: number; to?: number }
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function copyIfAbsent(source: string, target: string): void {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  // A crash before rename leaves only a replaceable staging file, never a partial destination.
  const staging = `${target}.pending`;
  fs.copyFileSync(source, staging);
  const descriptor = fs.openSync(staging, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(staging, target);
}
const HOSTS: Record<string, string> = { dots: 'chatgpt.com', muse: 'muse.ai', grok: 'grok.com' };
export function sourceUrl(provider: string, input: unknown): string {
  try {
    const u = new URL(String(input));
    if (u.protocol !== 'https:' || !HOSTS[provider] || u.hostname !== HOSTS[provider] || u.username || u.password) return '';
    u.search = ''; u.hash = '';
    return u.href.slice(0, 500);
  } catch { return ''; }
}
export function chunks(text: string): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length; start += 850) { out.push(text.slice(start, start + 1000)); if (start + 1000 >= text.length) break; }
  return out;
}
const STOP = new Set('what which who when where why how did do does was were is are the a an of to in on for and or my our about with it we they this that from have has should can'.split(' '));
export function terms(query: string): string[] { return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(w => !STOP.has(w)).slice(0, 24); }

export class HistoryStore {
  readonly db: DatabaseSync;
  migrationWarning = '';
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'history.sqlite'));
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1) { this.db.close(); throw new Error(`History schema ${version} is newer than supported schema 1. Use a compatible blibs version; the database was not changed.`); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, provider TEXT NOT NULL, threadId TEXT NOT NULL, sourceId TEXT NOT NULL,
        identity TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, url TEXT NOT NULL, UNIQUE(provider,threadId,sourceId));
      CREATE INDEX IF NOT EXISTS messages_filters ON messages(provider,threadId,ts,role);
      CREATE INDEX IF NOT EXISTS messages_time ON messages(ts,id);
      CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, snippet TEXT NOT NULL, contentHash TEXT NOT NULL, model TEXT, vector BLOB, UNIQUE(messageId,ordinal));
      CREATE VIRTUAL TABLE IF NOT EXISTS keyword USING fts5(snippet, content='chunks', content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO keyword(rowid,snippet) VALUES(new.id,new.snippet); END;
      CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO keyword(keyword,rowid,snippet) VALUES('delete',old.id,old.snippet); END;
      PRAGMA user_version=1; COMMIT;`);
    this.migrate(dataDir);
  }
  private migrate(dataDir: string): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key='legacy-import-v1'").get();
    if (migrated) {
      const report = JSON.parse(String(migrated.value)) as { rejected?: number };
      if (report.rejected) this.migrationWarning = `${report.rejected} invalid legacy rows skipped; original and backup preserved.`;
      return;
    }
    const file = path.join(dataDir, 'imports.json');
    if (!fs.existsSync(file)) return;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error('expected an array');
      const backup = path.join(dataDir, 'imports.pre-sqlite.json');
      copyIfAbsent(file, backup);
      const report = this.import(data, true);
      this.db.prepare("INSERT INTO metadata VALUES('legacy-import-v1',?)").run(JSON.stringify({ hash: hash(raw), ...report }));
      if (report.rejected) this.migrationWarning = `${report.rejected} invalid legacy rows skipped; original and backup preserved.`;
    } catch (error) { this.migrationWarning = `Legacy migration pending: ${String(error)}. Original JSON preserved; fix it and restart.`; }
  }
  import(items: unknown[], legacy = false, onAdded?: (messages: HistoryMessage[]) => void): { added: number; updated: number; rejected: number; total: number } {
    let added = 0, updated = 0, rejected = 0;
    const inserted: HistoryMessage[] = [];
    const occurrences = new Map<string, number>();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') { rejected++; continue; }
        const item = raw as Record<string, unknown>;
        if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 32000) { rejected++; continue; }
        const provider = String(item.provider || 'custom').toLowerCase().slice(0, 40);
        const role = item.role === 'agent' ? 'agent' : 'user';
        const text = item.text.trim(), url = sourceUrl(provider, item.url);
        const threadId = String(item.threadId || url || 'unknown-thread').slice(0, 500);
        const ts = typeof item.ts === 'number' && Number.isFinite(item.ts) ? item.ts : Date.now();
        const fingerprint = hash(JSON.stringify([provider, threadId, role, Number(item.ts) || 0, text]));
        const occurrence = occurrences.get(fingerprint) || 0;
        occurrences.set(fingerprint, occurrence + 1);
        // Legacy migration preserves repeated stored rows. Legacy API duplicates in one request retain its old behavior.
        let sourceId = typeof item.sourceId === 'string' && item.sourceId ? item.sourceId.slice(0, 500) : `legacy:${fingerprint}:${legacy ? occurrence : 0}`;
        const identity = String(item.identity || (item.sourceId ? 'source-id' : 'legacy-timestamp')).slice(0, 40);
        // A reused DOM slot is not a stable vendor ID. Keep changed content rather than overwrite an older retained message.
        if (identity === 'rendered-position') sourceId += `:${hash(text)}`;
        const id = hash(JSON.stringify([provider, threadId, sourceId]));
        const existing = this.db.prepare('SELECT text,role,url,identity FROM messages WHERE id=?').get(id) as { text: string; role: string; url: string; identity: string } | undefined;
        if (existing?.text === text) {
          if (existing.role !== role || existing.url !== url || existing.identity !== identity) { this.db.prepare('UPDATE messages SET role=?,url=?,identity=? WHERE id=?').run(role, url, identity, id); updated++; }
          continue;
        }
        if (existing) {
          this.db.prepare('UPDATE messages SET text=?,url=?,role=?,identity=? WHERE id=?').run(text, url, role, identity, id);
          this.db.prepare('DELETE FROM chunks WHERE messageId=?').run(id); updated++;
        } else {
          this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)').run(id, provider, threadId, sourceId, identity, role, text, ts, url); added++;
          inserted.push({ id, provider, threadId, sourceId, identity, role, text, ts, url });
        }
        chunks(text).forEach((snippet, ordinal) => this.db.prepare('INSERT INTO chunks(messageId,ordinal,snippet,contentHash) VALUES(?,?,?,?)').run(id, ordinal, snippet, hash(snippet)));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // Call after COMMIT: the relay must not act on a row that was rolled back.
    if (inserted.length) onAdded?.(inserted);
    return { added, updated, rejected, total: this.count() };
  }
  count(): number { return Number(this.db.prepare('SELECT count(*) AS n FROM messages').get()!.n); }
  /** Threads that the store already knows. The relay uses them as baseline. */
  threads(provider: string): string[] {
    return (this.db.prepare('SELECT DISTINCT threadId FROM messages WHERE provider=? ORDER BY threadId LIMIT 2000').all(provider) as unknown as { threadId: string }[])
      .map((row) => row.threadId);
  }
  list(limit = 500, offset = 0): HistoryMessage[] { return this.db.prepare('SELECT * FROM messages ORDER BY ts,id LIMIT ? OFFSET ?').all(limit, offset) as unknown as HistoryMessage[]; }
  recent(): HistoryMessage[] { return (this.db.prepare('SELECT * FROM messages ORDER BY ts DESC,id DESC LIMIT 500').all() as unknown as HistoryMessage[]).reverse(); }
  message(id: string): HistoryMessage | undefined { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as HistoryMessage | undefined; }
  private filter(filters: SearchFilters): { sql: string; values: (string | number)[] } {
    const parts: string[] = [], values: (string | number)[] = [];
    for (const key of ['provider', 'threadId'] as const) if (filters[key]) { parts.push(`m.${key}=?`); values.push(filters[key]!); }
    if (filters.from !== undefined) { parts.push('m.ts>=?'); values.push(filters.from); }
    if (filters.to !== undefined) { parts.push('m.ts<=?'); values.push(filters.to); }
    return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', values };
  }
  keyword(query: string, filters: SearchFilters = {}, limit = 50): Passage[] {
    const words = terms(query); if (!words.length) return [];
    const f = this.filter(filters);
    return this.db.prepare(`WITH ranked AS MATERIALIZED (SELECT m.*,c.id AS chunkId,c.snippet,-bm25(keyword) AS score FROM keyword JOIN chunks c ON c.id=keyword.rowid JOIN messages m ON m.id=c.messageId
      WHERE keyword MATCH ? ${f.sql}) SELECT *,max(score) AS score FROM ranked GROUP BY id ORDER BY score DESC,chunkId LIMIT ?`).all(words.map(w => `"${w}"`).join(' OR '), ...f.values, limit) as unknown as Passage[];
  }
  vectors(model: string, filters: SearchFilters, after: number): (Passage & { vector: Uint8Array })[] {
    const f = this.filter(filters);
    return this.db.prepare(`SELECT m.*,c.id AS chunkId,c.snippet,c.vector,0 AS score FROM chunks c JOIN messages m ON m.id=c.messageId WHERE c.model=? AND c.id>? ${f.sql} ORDER BY c.id LIMIT 256`).all(model, after, ...f.values) as unknown as (Passage & { vector: Uint8Array })[];
  }
  pending(model: string): { id: number; snippet: string; contentHash: string }[] { return this.db.prepare('SELECT id,snippet,contentHash FROM chunks WHERE model IS NULL OR model<>? ORDER BY id LIMIT 8').all(model) as unknown as { id: number; snippet: string; contentHash: string }[]; }
  saveVector(id: number, contentHash: string, model: string, values: number[]): void {
    this.db.prepare('UPDATE chunks SET vector=?,model=? WHERE id=? AND contentHash=?').run(new Uint8Array(new Float32Array(values).buffer), model, id, contentHash);
  }
  indexStatus(model: string) { return this.db.prepare('SELECT count(*) AS total,sum(CASE WHEN model=? THEN 1 ELSE 0 END) AS indexed FROM chunks').get(model); }
  isIndexPaused(): boolean {
    return this.db.prepare("SELECT value FROM metadata WHERE key='index-paused'").get()?.value === 'true';
  }
  setIndexPaused(paused: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('index-paused',?)").run(String(paused));
  }
  rebuild(): void { this.db.prepare('UPDATE chunks SET model=NULL,vector=NULL').run(); }
  context(p: Passage, filters: SearchFilters): HistoryMessage[] {
    const f = this.filter(filters);
    return this.db.prepare(`SELECT m.* FROM messages m WHERE m.provider=? AND m.threadId=? ${f.sql} ORDER BY abs(m.ts-?),m.ts,m.id LIMIT 3`).all(p.provider, p.threadId, ...f.values, p.ts) as unknown as HistoryMessage[];
  }
  close(): void { this.db.close(); }
}
