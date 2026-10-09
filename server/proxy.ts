// blibs local backend: import store + send outbox for the desktop app.
// The Electron main process spawns this (`npm start`) and the panel talks
// to it via /api/* (forwarded by the desktop static server).
//
//   POST /api/import  { items: [{provider, role, text, ts?, url?}] }
//   GET  /api/imports -> { imports: [...] }
//   POST /api/outbox        { provider, text } -> { ok, id } (enqueue)
//   GET  /api/outbox/pending -> { items: [queued...] } (views poll via main)
//   POST /api/outbox/ack    { id, ok, error? } (delivery confirmation)
//   POST /api/outbox/retry  { id } (requeue a failed item)
//   GET  /api/outbox         -> { items: [...] } (delivery statuses for blibs)
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PROXY_PORT || 8787);
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

interface Route {
  url: string;
  keyHeader: string;
  bearer: boolean;
}

const ROUTES: Record<string, Route> = {
  muse: { url: 'https://api.meta.ai/v1/chat/completions', keyHeader: 'Authorization', bearer: true },
  dots: { url: 'https://api.openai.com/v1/chat/completions', keyHeader: 'Authorization', bearer: true },
  grok: { url: 'https://api.x.ai/v1/chat/completions', keyHeader: 'Authorization', bearer: true },
  custom: { url: process.env.CUSTOM_API_URL || 'https://api.openai.com/v1/chat/completions', keyHeader: 'Authorization', bearer: true },
};

const MODELS: Record<string, string> = {
  muse: 'muse-spark-1.3',
  dots: 'gpt-5-mini',
  grok: 'grok-4-7',
  custom: 'gpt-5-mini',
};

interface ImportItem {
  provider: string;
  role: string;
  text: string;
  ts: number;
  url: string;
}

interface OutboxItem {
  id: string;
  provider: string;
  text: string;
  ts: number;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  sentAt?: number;
  error?: string;
  clientId?: string;
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

/** Each server owns its store and deduplication state. Tests use a temporary directory. */
export function createProxyServer(dataDir = process.env.BLIBS_DATA_DIR || SERVER_DIR): http.Server {
  fs.mkdirSync(dataDir, { recursive: true });
  const STORE_PATH = path.join(dataDir, 'imports.json');
  const OUTBOX_PATH = path.join(dataDir, 'outbox.json');

  // ---- import store (file-backed, best-effort) ----
  function loadImports(): ImportItem[] {
    try {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const data: unknown = JSON.parse(raw);
      return Array.isArray(data) ? (data as ImportItem[]) : [];
    } catch {
      return [];
    }
  }
  function saveImports(items: ImportItem[]): void {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(items.slice(-2000), null, 2));
    } catch { /* ephemeral in some sandboxes */ }
  }
  const seen = new Set(loadImports().map((m) => `${m.provider}|${m.role}|${m.text}`));

  // ---- outbox store: messages blibs wants typed into vendor views ----
  function loadOutbox(): OutboxItem[] {
    try {
      const raw = fs.readFileSync(OUTBOX_PATH, 'utf8');
      const data: unknown = JSON.parse(raw);
      return Array.isArray(data) ? (data as OutboxItem[]) : [];
    } catch {
      return [];
    }
  }
  function saveOutbox(items: OutboxItem[]): void {
    try {
      fs.writeFileSync(OUTBOX_PATH, JSON.stringify(items.slice(-500), null, 2));
    } catch { /* ephemeral in some sandboxes */ }
  }
  function newOutId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body = '';
    for await (const chunk of req) body += chunk;
    return JSON.parse(body) as Record<string, unknown>;
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' });
        return res.end();
      }
      if (req.url === '/api/health') return send(res, 200, { ok: true });

      // Desktop views -> blibs: fetch everything scraped so far.
      if (req.url === '/api/imports' && req.method === 'GET') {
        return send(res, 200, { imports: loadImports().slice(-500) });
      }

      // Desktop views -> blibs: push scraped messages from vendor sessions.
      if (req.url === '/api/import' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload: { items?: unknown };
        try { payload = JSON.parse(body) as { items?: unknown }; } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const items = Array.isArray(payload?.items) ? (payload.items as Record<string, unknown>[]) : [];
        const store = loadImports();
        let added = 0;
        for (const it of items) {
          const provider = String(it.provider || 'custom').toLowerCase();
          const role = it.role === 'agent' ? 'agent' : 'user';
          const text = String(it.text || '').trim().slice(0, 4000);
          if (!text) continue;
          const key = `${provider}|${role}|${text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          store.push({ provider, role, text, ts: Number(it.ts) || Date.now(), url: String(it.url || '').slice(0, 300) });
          added++;
        }
        saveImports(store);
        return send(res, 200, { ok: true, added, total: store.length });
      }

      // Blibs -> vendor views: enqueue a message for delivery.
      if (req.url === '/api/outbox' && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const provider = String(payload?.provider || 'custom').toLowerCase();
        const text = String(payload?.text || '').trim().slice(0, 4000);
        if (!text) return send(res, 400, { error: 'missing text' });
        const store = loadOutbox();
      const clientId = typeof payload?.clientId === 'string' ? payload.clientId.slice(0, 100) : undefined;
      const existing = clientId && store.find((item) => item.clientId === clientId);
      if (existing) {
        if (existing.provider !== provider || existing.text !== text) return send(res, 409, { error: 'This message ID already belongs to another message.' });
        return send(res, 200, { ok: true, id: existing.id, status: existing.status });
      }
      const item: OutboxItem = { id: newOutId(), provider, text, ts: Date.now(), status: 'queued', attempts: 0, clientId };
        store.push(item);
        saveOutbox(store);
      return send(res, 200, { ok: true, id: item.id, status: item.status });
      }

      // Main process polls this: oldest queued messages first.
      if (req.url === '/api/outbox/pending' && req.method === 'GET') {
        const items = loadOutbox().filter((m) => m.status === 'queued');
        return send(res, 200, { items });
      }

      // Main process confirms (or reports failure for) a delivery.
      if (req.url === '/api/outbox/ack' && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const store = loadOutbox();
        const item = store.find((m) => m.id === payload?.id);
        if (!item) return send(res, 404, { error: 'unknown id' });
        item.attempts = (item.attempts || 0) + 1;
        if (payload?.ok) {
          item.status = 'sent';
          item.sentAt = Date.now();
          delete item.error;
        } else {
          item.status = 'failed';
          item.error = String(payload?.error || 'send failed').slice(0, 300);
        }
        saveOutbox(store);
        return send(res, 200, { ok: true, id: item.id, status: item.status });
      }

      // Only failed messages can be sent again. A repeated retry remains idempotent.
      if (req.url === '/api/outbox/retry' && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const store = loadOutbox();
        const item = store.find((m) => m.id === payload?.id);
        if (!item) return send(res, 404, { error: 'unknown id' });
        if (item.status === 'sent') return send(res, 409, { error: 'This message has already been sent.' });
        item.status = 'queued';
        delete item.error;
        saveOutbox(store);
        return send(res, 200, { ok: true, id: item.id, status: 'queued' });
      }

      // Blibs delivery-status panel / auto-pull tick.
      if (req.url === '/api/outbox' && req.method === 'GET') {
        return send(res, 200, { items: loadOutbox().slice(-200) });
      }

      if (req.url !== '/api/chat' || req.method !== 'POST') return send(res, 404, { error: 'use POST /api/chat, /api/import or /api/outbox' });

      let body = '';
      for await (const chunk of req) body += chunk;
      let payload: { provider?: string; apiKey?: string; message?: string; model?: string };
      try { payload = JSON.parse(body) as typeof payload; } catch { return send(res, 400, { error: 'invalid JSON' }); }
      const { provider = 'dots', apiKey, message, model } = payload;
      if (!apiKey) return send(res, 400, { error: 'missing apiKey (paste it in API keys bar)' });
      if (!message) return send(res, 400, { error: 'missing message' });
      const route = ROUTES[provider] ?? ROUTES.dots;

      try {
        const upstream = await fetch(route.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [route.keyHeader]: `${route.bearer ? 'Bearer ' : ''}${apiKey}` },
          body: JSON.stringify({
            model: model || MODELS[provider] || 'gpt-5-mini',
            messages: [
              { role: 'system', content: 'You are the user\'s personal agent inside blibs, a unified control panel. Be concise, agentic, propose next actions.' },
              { role: 'user', content: message },
            ],
          }),
        });
        const data = (await upstream.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
        if (!upstream.ok) return send(res, upstream.status, { error: data?.error?.message || 'upstream error', raw: data });
        const reply = data?.choices?.[0]?.message?.content || JSON.stringify(data).slice(0, 2000);
        return send(res, 200, { reply, provider });
      } catch (e) {
        return send(res, 502, { error: String(e) });
      }
    })().catch((e) => {
      try { send(res, 500, { error: String(e) }); } catch { /* already sent */ }
    });
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createProxyServer().listen(PORT, '127.0.0.1', () => console.log(`blibs proxy on http://127.0.0.1:${PORT}`));
}
