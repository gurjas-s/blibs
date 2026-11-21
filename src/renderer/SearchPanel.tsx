import { useEffect, useRef, useState } from 'react';
import {
  askConversations,
  fetchHistoryItem,
  searchConversations,
} from './client';
import type { HistoryMessage, SearchResponse } from './client';
import type { SearchCommand } from './search';
import { Button } from './components/Button';

export interface SearchPanelProps {
  /** The current search. A new id replaces the shown results. */
  command: SearchCommand | null;
  onOpenThread?: (provider: string, url: string) => void;
}

/** Results-only pane for the global topbar search. */
export default function SearchPanel({ command, onOpenThread }: SearchPanelProps) {
  const [response, setResponse] = useState<SearchResponse>({});
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<HistoryMessage | null>(null);
  const controller = useRef<AbortController | null>(null);
  const handled = useRef(0);

  async function run(from: SearchCommand, ask: boolean, nextOffset = 0) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setError('');
    setSelected(null);
    try {
      const body = { query: from.text, offset: nextOffset, filters: from.filters };
      const data = await (ask
        ? askConversations(body, current.signal)
        : searchConversations(body, current.signal));
      if (controller.current === current) {
        setResponse(data);
        setOffset(nextOffset);
      }
    } catch (err) {
      if (!current.signal.aborted) setError(String(err));
    }
  }
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });
  useEffect(() => {
    if (!command || command.id === handled.current) return;
    handled.current = command.id;
    void runRef.current(command, command.ask);
  }, [command]);
  useEffect(() => () => { controller.current?.abort(); }, []);

  async function open(id: string) {
    try { setSelected(await fetchHistoryItem(id)); } catch (err) { setError(String(err)); }
  }
  function threadLink(provider: string, url: string, label: string) {
    return <a href={url} target="_blank" rel="noreferrer" onClick={(event) => {
      if (!onOpenThread) return;
      event.preventDefault();
      onOpenThread(provider, url);
    }}>{label}</a>;
  }

  const results = response.results || response.sources || [];
  const notice = error || response.warning;
  return <section className="history-search" aria-label="Conversation search results">
    <div className="history-results" aria-live="polite">
      {notice && <p role="status" className="history-notice">{notice}</p>}
      {response.answer && <article className="grounded-answer"><h2>{response.abstained ? 'More evidence needed' : 'Selected evidence · experimental'}</h2>{response.abstained ? <p>{response.answer} {response.reason}</p> : response.claims?.map((claim, i) => <p key={`${claim.sourceId}-${i}`}>{claim.text} <Button variant="ghost" size="sm" className="citation" onClick={() => void open(claim.sourceId)}>[{i + 1}] View source</Button></p>)}</article>}
      {selected && <article className="source-detail" id={`message-${selected.id}`}><h2>Source message</h2><p>{selected.provider} · {selected.role} · {new Date(selected.ts).toLocaleString()}</p><p>{selected.threadId}</p><blockquote>{selected.text}</blockquote>{selected.url && threadLink(selected.provider, selected.url, 'Open original thread')}<Button variant="secondary" size="sm" onClick={() => setSelected(null)}>Close source</Button></article>}
      {results.map(result => <article className="history-result" key={result.id}>
        <div className="result-provenance"><strong>{result.provider}</strong><span>{result.role}</span><time>{new Date(result.ts).toLocaleString()}</time></div>
        <p className="result-thread">{result.threadId}</p><p>{result.snippet}</p>
        <Button variant="secondary" size="sm" onClick={() => void open(result.id)}>View message</Button>{result.url && threadLink(result.provider, result.url, 'Open thread')}
        {result.identity !== 'source-id' && <small>Source identity: {result.identity}; rendered history may be incomplete.</small>}
        {result.context && result.context.length > 1 && <details><summary>Nearby messages</summary>{result.context.filter(c => c.id !== result.id).map(c => <p key={c.id}><strong>{c.role}:</strong> {c.text}</p>)}</details>}
      </article>)}
      {response.results && !results.length && <p>No matching retained messages. Try another query or provider.</p>}
      {command && response.results && <div className="history-actions"><Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => void run(command, false, Math.max(0, offset - 10))}>Previous</Button><Button variant="secondary" size="sm" disabled={!response.hasMore} onClick={() => void run(command, false, offset + 10)}>Next</Button><small>{response.mode} · {Math.round(response.latencyMs || 0)} ms</small></div>}
    </div>
  </section>;
}
