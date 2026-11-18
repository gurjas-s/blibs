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
import { HistoryStore, copyIfAbsent } from './history.js';
import { RetrievalService } from './retrieval.js';
import type { LocalModels } from './retrieval.js';
import type { SearchFilters } from './history.js';
import { RelayService, relayConfigFromEnv } from './relay.js';
import type { RelayConfig } from './relay.js';

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

interface OutboxItem {
  id: string;
  provider: string;
  text: string;
  ts: number;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  sentAt?: number;
  error?: string;
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** Each server owns its store and deduplication state. Tests use a temporary directory. */
export interface ProxyOptions {
  /** Overrides the relay configuration from the environment. Tests use this. */
  relay?: Partial<RelayConfig>;
}

export function createProxyServer(dataDir = process.env.BLIBS_DATA_DIR || SERVER_DIR, models: LocalModels = {}, options: ProxyOptions = {}): http.Server {
  fs.mkdirSync(dataDir, { recursive: true });
  // Copy retained legacy files on first desktop startup. Originals and delivery records are preserved.
  const legacyDir = process.env.BLIBS_LEGACY_DIR;
  if (legacyDir && path.resolve(legacyDir) !== path.resolve(dataDir)) {
    for (const name of ['imports.json', 'outbox.json']) {
      const source = path.join(legacyDir, name), target = path.join(dataDir, name);
      copyIfAbsent(source, target);
    }
  }
  const OUTBOX_PATH = path.join(dataDir, 'outbox.json');
  const history = new HistoryStore(dataDir);
  const retrieval = new RetrievalService(history, models);
  retrieval.schedule();

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
  /** The one outbox write path. The panel and the relay both use it. */
  function enqueueOutbox(provider: string, text: string): OutboxItem {
    const store = loadOutbox();
    const item: OutboxItem = { id: newOutId(), provider, text, ts: Date.now(), status: 'queued', attempts: 0 };
    store.push(item);
    saveOutbox(store);
    return item;
  }
  const relay = new RelayService({
    config: { ...relayConfigFromEnv(process.env, dataDir), ...options.relay },
    stateDir: dataDir,
    enqueue: (provider, text) => { enqueueOutbox(provider, text.slice(0, 4000)); },
  });
  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4_000_000) throw new Error('Request exceeds 4 MB.'); }
    return JSON.parse(body) as Record<string, unknown>;
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const address = server.address();
      const backendPort = address && typeof address !== 'string' ? address.port : PORT;
      const allowed = new Set([`127.0.0.1:${backendPort}`, `127.0.0.1:${Number(process.env.BLIBS_UI_PORT || 5174)}`]);
      if (!req.headers.host || !allowed.has(req.headers.host)) return send(res, 403, { error: 'Untrusted local API host.' });
      if (req.headers.origin && ![...allowed].some(host => req.headers.origin === `http://${host}`)) return send(res, 403, { error: 'Untrusted origin. Open the local blibs panel.' });
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Vary': 'Origin' });
        return res.end();
      }
      if (req.url === '/api/health') return send(res, 200, { ok: true });
      if (req.url === '/api/relay' && req.method === 'GET') return send(res, 200, relay.status());
      const routeUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (routeUrl.pathname === '/api/history' && req.method === 'GET') {
        const limit = Math.min(500, Math.max(1, Number(routeUrl.searchParams.get('limit')) || 100));
        const offset = Math.max(0, Number(routeUrl.searchParams.get('offset')) || 0);
        return send(res, 200, { items: history.list(limit, offset), total: history.count() });
      }
      if (routeUrl.pathname.startsWith('/api/history/') && req.method === 'GET') {
        const item = history.message(routeUrl.pathname.slice('/api/history/'.length));
        return send(res, item ? 200 : 404, item ? { item } : { error: 'Unknown message.' });
      }
      if (req.url === '/api/index' && req.method === 'GET') return send(res, 200, retrieval.status());
      if (req.url === '/api/index' && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        if (payload.action === 'cancel') await retrieval.cancel();
        else { if (payload.action === 'rebuild') { await retrieval.cancel(); history.rebuild(); } void retrieval.startIndex(); }
        return send(res, 200, retrieval.status());
      }
      if ((req.url === '/api/search' || req.url === '/api/ask') && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const query = typeof payload.query === 'string' ? payload.query.trim() : '';
        if (!query || query.length > 1000) return send(res, 400, { error: 'Enter a question or search query of 1–1,000 characters.' });
        const rawFilters = payload.filters && typeof payload.filters === 'object' ? payload.filters as Record<string, unknown> : {};
        const filters: SearchFilters = {};
        for (const key of ['provider', 'threadId'] as const) if (typeof rawFilters[key] === 'string') filters[key] = rawFilters[key].slice(0, 500);
        for (const key of ['from', 'to'] as const) if (rawFilters[key] !== undefined) {
          if (typeof rawFilters[key] !== 'number' || !Number.isFinite(rawFilters[key])) return send(res, 400, { error: 'Date filters must be finite epoch milliseconds.' });
          filters[key] = rawFilters[key];
        }
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const data = req.url === '/api/ask' ? await retrieval.ask(query, filters, controller.signal) : await retrieval.search(query, filters, payload.mode === 'keyword' ? 'keyword' : 'hybrid', Math.min(50, Math.max(1, Number(payload.limit) || 10)), Math.max(0, Number(payload.offset) || 0), controller.signal);
          return send(res, 200, data);
        } catch (error) { if (!controller.signal.aborted) return send(res, 503, { error: String(error) }); return; }
      }

      // Desktop views -> blibs: fetch everything scraped so far.
      if (req.url === '/api/imports' && req.method === 'GET') {
        return send(res, 200, { imports: history.recent() });
      }

      // Desktop views -> blibs: push scraped messages from vendor sessions.
      if (req.url === '/api/import' && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (items.length > 2000) return send(res, 400, { error: 'Import at most 2,000 messages per request.' });
        const report = history.import(items, false, (message) => relay.observe(message));
        retrieval.schedule();
        return send(res, 200, { ok: true, ...report });
      }

      // Blibs -> vendor views: enqueue a message for delivery.
      if (req.url === '/api/outbox' && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const provider = String(payload?.provider || 'custom').toLowerCase();
        const text = String(payload?.text || '').trim().slice(0, 4000);
        if (!text) return send(res, 400, { error: 'missing text' });
        const item = enqueueOutbox(provider, text);
        return send(res, 200, { ok: true, id: item.id });
      }

      // Main process polls this: oldest queued messages first.
      if (req.url === '/api/outbox/pending' && req.method === 'GET') {
        const items = loadOutbox().filter((m) => m.status === 'queued').slice(0, 20);
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

      // Blibs "retry" button: requeue a failed (or even sent) item.
      if (req.url === '/api/outbox/retry' && req.method === 'POST') {
        let payload: Record<string, unknown>;
        try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const store = loadOutbox();
        const item = store.find((m) => m.id === payload?.id);
        if (!item) return send(res, 404, { error: 'unknown id' });
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
  let serverClosed = false;
  server.on('close', () => {
    if (serverClosed) return;
    serverClosed = true;
    relay.close();
    void retrieval.close().catch(() => { /* already closed */ });
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createProxyServer();
  const shutdown = (): void => {
    server.close();
    server.closeAllConnections?.();
    // The relay kills its harness child from the close handler.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(PORT, '127.0.0.1', () => console.log(`blibs proxy on http://127.0.0.1:${PORT}`));
}
