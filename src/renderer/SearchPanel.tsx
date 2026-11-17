import { useCallback, useEffect, useRef, useState } from 'react';
import {
  askConversations,
  fetchHistoryItem,
  fetchIndexStatus,
  searchConversations,
  updateIndex,
} from './client';
import type {
  HistoryMessage,
  IndexStatus,
  SearchFilters,
  SearchResponse,
} from './client';
import { Button } from './components/Button';
import { SelectField } from './components/SelectField';
import { TextField } from './components/TextField';

/** One topbar submit. The panel runs the search once for each new id. */
export interface SearchRunRequest {
  id: number;
  text: string;
}

export interface SearchPanelProps {
  /** Text from the shared topbar search input. */
  query: string;
  /** Latest topbar submit, or null when there is none to run. */
  request: SearchRunRequest | null;
  /** Report a handled request so a later mount does not run it again. */
  onRequestHandled: (id: number) => void;
}

export default function SearchPanel({ query, request, onRequestHandled }: SearchPanelProps) {
  const [provider, setProvider] = useState('');
  const [threadId, setThreadId] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [response, setResponse] = useState<SearchResponse>({});
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<HistoryMessage | null>(null);
  const controller = useRef<AbortController | null>(null);
  const previousQuery = useRef(query);
  const handledRequest = useRef(0);
  const resetResults = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setResponse({});
    setOffset(0);
    setSelected(null);
    setBusy(false);
    setError('');
  }, []);
  useEffect(() => {
    const load = () => { void fetchIndexStatus().then(setStatus).catch(() => {}); };
    load(); const timer = setInterval(load, 2500);
    return () => { clearInterval(timer); controller.current?.abort(); };
  }, []);
  // A new topbar query removes the old results but does not run a search.
  useEffect(() => {
    if (previousQuery.current === query) return;
    previousQuery.current = query;
    resetResults();
  }, [query, resetResults]);
  async function run(ask: boolean, nextOffset = 0, text = query) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setSelected(null);
    try {
      const filters: SearchFilters = {
        provider: provider || undefined,
        threadId: threadId || undefined,
        from: from ? new Date(`${from}T00:00:00`).getTime() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).getTime() : undefined,
      };
      const body = { query: text, offset: nextOffset, filters };
      const data = await (ask
        ? askConversations(body, current.signal)
        : searchConversations(body, current.signal));
      if (controller.current === current) { setResponse(data); setOffset(nextOffset); }
    } catch (err) { if (!current.signal.aborted) setError(String(err)); }
    finally { if (controller.current === current) setBusy(false); }
  }
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });
  // Enter in the topbar runs this scope. A full request id runs one time.
  useEffect(() => {
    if (!request || request.id <= handledRequest.current) return;
    handledRequest.current = request.id;
    void runRef.current(false, 0, request.text);
    onRequestHandled(request.id);
  }, [request, onRequestHandled]);
  async function index(action: 'resume' | 'cancel' | 'rebuild') {
    try { setStatus(await updateIndex(action)); } catch (err) { setError(String(err)); }
  }
  async function open(id: string) {
    try { setSelected(await fetchHistoryItem(id)); } catch (err) { setError(String(err)); }
  }
  const results = response.results || response.sources || [];
  return <section className="history-search" aria-label="Conversation search">
    <div className="thread-head"><div><h1>Search conversations</h1></div></div>
    <form onSubmit={e => { e.preventDefault(); void run(false); }} className="history-form">
      <div className="history-filters">
        <SelectField label="Provider" value={provider} onChange={e => { setProvider(e.target.value); resetResults(); }}><option value="">All providers</option><option value="dots">Dots</option><option value="muse">Muse</option><option value="grok">Grok</option><option value="custom">Custom</option></SelectField>
        <TextField label="Thread URL or ID" value={threadId} onChange={e => { setThreadId(e.target.value); resetResults(); }} placeholder="Any thread" />
        <TextField label="From" type="date" value={from} onChange={e => { setFrom(e.target.value); resetResults(); }} />
        <TextField label="To" type="date" value={to} onChange={e => { setTo(e.target.value); resetResults(); }} />
      </div>
      <div className="history-actions">
        <Button type="submit" variant="primary" disabled={busy || !query.trim()}>Search</Button>
        <Button variant="secondary" disabled={busy || !query.trim() || !status?.generationConfigured} onClick={() => void run(true)}>Ask locally</Button>
        {busy && <Button variant="ghost" onClick={() => { controller.current?.abort(); setBusy(false); }}>Cancel</Button>}
      </div>
    </form>
    <div className="index-state" aria-live="polite">
      <span>{status ? `${status.indexed || 0}/${status.total} passages indexed${status.paused ? ' · paused' : status.running ? ' · indexing…' : ''}` : 'Connecting to history…'}</span>
      <span>{status?.embeddingConfigured ? 'Local semantic search' : 'Keyword search available'}</span>
      <span>{status?.generationConfigured ? 'Experimental local answers' : 'Configure a local model to ask'}</span>
      <Button variant="secondary" size="sm" disabled={!status?.embeddingConfigured} onClick={() => void index(status?.paused ? 'resume' : 'cancel')}>{status?.paused ? 'Resume indexing' : 'Pause indexing'}</Button>
      <Button variant="secondary" size="sm" disabled={!status?.embeddingConfigured} onClick={() => void index('rebuild')}>Rebuild vectors</Button>
    </div>
    {(error || status?.error || status?.migrationWarning || response.warning) && <p role="status" className="history-notice">{error || status?.error || status?.migrationWarning || response.warning}</p>}
    <div className="history-results" aria-live="polite">
      {response.answer && <article className="grounded-answer"><h2>{response.abstained ? 'More evidence needed' : 'Selected evidence · experimental'}</h2>{response.abstained ? <p>{response.answer} {response.reason}</p> : response.claims?.map((claim, i) => <p key={`${claim.sourceId}-${i}`}>{claim.text} <Button variant="ghost" size="sm" className="citation" onClick={() => void open(claim.sourceId)}>[{i + 1}] View source</Button></p>)}</article>}
      {selected && <article className="source-detail" id={`message-${selected.id}`}><h2>Source message</h2><p>{selected.provider} · {selected.role} · {new Date(selected.ts).toLocaleString()}</p><p>{selected.threadId}</p><blockquote>{selected.text}</blockquote>{selected.url && <a href={selected.url} target="_blank" rel="noreferrer">Open original thread ↗</a>}<Button variant="secondary" size="sm" onClick={() => setSelected(null)}>Close source</Button></article>}
      {results.map(result => <article className="history-result" key={result.id}>
        <div className="result-provenance"><strong>{result.provider}</strong><span>{result.role}</span><time>{new Date(result.ts).toLocaleString()}</time></div>
        <p className="result-thread">{result.threadId}</p><p>{result.snippet}</p>
        <Button variant="secondary" size="sm" onClick={() => void open(result.id)}>View message</Button>{result.url && <a href={result.url} target="_blank" rel="noreferrer">Open thread ↗</a>}
        {result.identity !== 'source-id' && <small>Source identity: {result.identity}; rendered history may be incomplete.</small>}
        {result.context && result.context.length > 1 && <details><summary>Nearby messages</summary>{result.context.filter(c => c.id !== result.id).map(c => <p key={c.id}><strong>{c.role}:</strong> {c.text}</p>)}</details>}
      </article>)}
      {response.results && !results.length && <p>No matching retained messages. Try another query or provider.</p>}
      {response.results && <div className="history-actions"><Button variant="secondary" size="sm" disabled={busy || offset === 0} onClick={() => void run(false, Math.max(0, offset - 10))}>Previous</Button><Button variant="secondary" size="sm" disabled={busy || !response.hasMore} onClick={() => void run(false, offset + 10)}>Next</Button><small>{response.mode} · {Math.round(response.latencyMs || 0)} ms</small></div>}
    </div>
  </section>;
}
