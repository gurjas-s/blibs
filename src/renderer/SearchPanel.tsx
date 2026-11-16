import { useEffect, useRef, useState } from 'react';

interface Message { id: string; provider: string; threadId: string; role: string; text: string; ts: number; url: string; identity: string }
interface Result extends Message { snippet: string; context?: Message[] }
interface Claim { text: string; sourceId: string; quote: string }
interface IndexStatus { total: number; indexed: number; running: boolean; paused: boolean; embeddingConfigured: boolean; generationConfigured: boolean; error?: string; migrationWarning?: string }
interface Response { results?: Result[]; sources?: Result[]; claims?: Claim[]; answer?: string; abstained?: boolean; reason?: string; warning?: string; hasMore?: boolean; latencyMs?: number; mode?: string }
async function api<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`); return data as T;
}
export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [threadId, setThreadId] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [response, setResponse] = useState<Response>({});
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Message | null>(null);
  const controller = useRef<AbortController | null>(null);
  function resetResults() {
    controller.current?.abort();
    controller.current = null;
    setResponse({});
    setOffset(0);
    setSelected(null);
    setBusy(false);
    setError('');
  }
  useEffect(() => {
    const load = () => { void api<IndexStatus>('/api/index').then(setStatus).catch(() => {}); };
    load(); const timer = setInterval(load, 2500);
    return () => { clearInterval(timer); controller.current?.abort(); };
  }, []);
  async function run(ask: boolean, nextOffset = 0) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setSelected(null);
    try {
      const data = await api<Response>(ask ? '/api/ask' : '/api/search', { query, offset: nextOffset, filters: { provider: provider || undefined, threadId: threadId || undefined, from: from ? new Date(`${from}T00:00:00`).getTime() : undefined, to: to ? new Date(`${to}T23:59:59.999`).getTime() : undefined } }, current.signal);
      if (controller.current === current) { setResponse(data); setOffset(nextOffset); }
    } catch (err) { if (!current.signal.aborted) setError(String(err)); }
    finally { if (controller.current === current) setBusy(false); }
  }
  async function index(action: string) { try { setStatus(await api<IndexStatus>('/api/index', { action })); } catch (err) { setError(String(err)); } }
  async function open(id: string) { try { const data = await api<{ item: Message }>(`/api/history/${encodeURIComponent(id)}`); setSelected(data.item); } catch (err) { setError(String(err)); } }
  const results = response.results || response.sources || [];
  return <section className="history-search" aria-label="Conversation search">
    <div className="thread-head"><div><h1>Search conversations</h1><p>Find decisions across your agents. Experimental local answers select supporting sentences; check their sources.</p></div></div>
    <form onSubmit={e => { e.preventDefault(); void run(false); }} className="history-form">
      <label>Search or ask<input value={query} onChange={e => { setQuery(e.target.value); resetResults(); }} placeholder="What did we decide about storage for Atlas?" maxLength={1000} /></label>
      <div className="history-filters">
        <label>Provider<select value={provider} onChange={e => { setProvider(e.target.value); resetResults(); }}><option value="">All providers</option><option value="dots">Dots</option><option value="muse">Muse</option><option value="grok">Grok</option><option value="custom">Custom</option></select></label>
        <label>Thread URL or ID<input value={threadId} onChange={e => { setThreadId(e.target.value); resetResults(); }} placeholder="Any thread" /></label>
        <label>From<input type="date" value={from} onChange={e => { setFrom(e.target.value); resetResults(); }} /></label>
        <label>To<input type="date" value={to} onChange={e => { setTo(e.target.value); resetResults(); }} /></label>
      </div>
      <div className="history-actions"><button className="primary" disabled={busy || !query.trim()}>Search</button><button type="button" disabled={busy || !query.trim() || !status?.generationConfigured} onClick={() => void run(true)}>Ask locally</button>{busy && <button type="button" onClick={() => { controller.current?.abort(); setBusy(false); }}>Cancel</button>}</div>
    </form>
    <div className="index-state" aria-live="polite">
      <span>{status ? `${status.indexed || 0}/${status.total} passages indexed${status.paused ? ' · paused' : status.running ? ' · indexing…' : ''}` : 'Connecting to history…'}</span>
      <span>{status?.embeddingConfigured ? 'Local semantic search' : 'Keyword search available'}</span>
      <span>{status?.generationConfigured ? 'Experimental local answers' : 'Configure a local model to ask'}</span>
      <button disabled={!status?.embeddingConfigured} onClick={() => void index(status?.paused ? 'resume' : 'cancel')}>{status?.paused ? 'Resume indexing' : 'Pause indexing'}</button>
      <button disabled={!status?.embeddingConfigured} onClick={() => void index('rebuild')}>Rebuild vectors</button>
    </div>
    {(error || status?.error || status?.migrationWarning || response.warning) && <p role="status" className="history-notice">{error || status?.error || status?.migrationWarning || response.warning}</p>}
    <div className="history-results" aria-live="polite">
      {response.answer && <article className="grounded-answer"><h2>{response.abstained ? 'More evidence needed' : 'Selected evidence · experimental'}</h2>{response.abstained ? <p>{response.answer} {response.reason}</p> : response.claims?.map((claim, i) => <p key={`${claim.sourceId}-${i}`}>{claim.text} <button className="citation" onClick={() => void open(claim.sourceId)}>[{i + 1}] View source</button></p>)}</article>}
      {selected && <article className="source-detail" id={`message-${selected.id}`}><h2>Source message</h2><p>{selected.provider} · {selected.role} · {new Date(selected.ts).toLocaleString()}</p><p>{selected.threadId}</p><blockquote>{selected.text}</blockquote>{selected.url && <a href={selected.url} target="_blank" rel="noreferrer">Open original thread ↗</a>}<button onClick={() => setSelected(null)}>Close source</button></article>}
      {results.map(result => <article className="history-result" key={result.id}>
        <div className="result-provenance"><strong>{result.provider}</strong><span>{result.role}</span><time>{new Date(result.ts).toLocaleString()}</time></div>
        <p className="result-thread">{result.threadId}</p><p>{result.snippet}</p>
        <button onClick={() => void open(result.id)}>View message</button>{result.url && <a href={result.url} target="_blank" rel="noreferrer">Open thread ↗</a>}
        {result.identity !== 'source-id' && <small>Source identity: {result.identity}; rendered history may be incomplete.</small>}
        {result.context && result.context.length > 1 && <details><summary>Nearby messages</summary>{result.context.filter(c => c.id !== result.id).map(c => <p key={c.id}><strong>{c.role}:</strong> {c.text}</p>)}</details>}
      </article>)}
      {response.results && !results.length && <p>No matching retained messages. Try another query or provider.</p>}
      {response.results && <div className="history-actions"><button disabled={busy || offset === 0} onClick={() => void run(false, Math.max(0, offset - 10))}>Previous</button><button disabled={busy || !response.hasMore} onClick={() => void run(false, offset + 10)}>Next</button><small>{response.mode} · {Math.round(response.latencyMs || 0)} ms</small></div>}
    </div>
  </section>;
}
