import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatMessage } from './types';
import { groupMessages } from './messages';
import { messageParts } from './text';

export default function ChatThread({ messages, agentName, query, empty, notice, onRetry, retrying, scrollRequest }: {
  messages: ChatMessage[];
  agentName: string;
  query: string;
  empty: ReactNode;
  notice?: ReactNode;
  onRetry(message: ChatMessage): void;
  retrying: string[];
  scrollRequest: number;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastId = messages.at(-1)?.id;
  const [position, setPosition] = useState({ atBottom: true, lastSeenId: lastId });
  const hasNew = !position.atBottom && position.lastSeenId !== lastId;

  function scrollToLatest() {
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
    stickToBottom.current = true;
  }
  useLayoutEffect(() => {
    if (query) { if (pane.current) pane.current.scrollTop = 0; return; }
    if (stickToBottom.current) scrollToLatest();
  }, [lastId, query]);
  useLayoutEffect(() => { scrollToLatest(); }, [scrollRequest]);

  return <div className="thread-area">
    <div className="thread" ref={pane} tabIndex={0} aria-label={`${agentName} messages`} onScroll={() => {
      const element = pane.current!;
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      setPosition((previous) => stickToBottom.current
        ? { atBottom: true, lastSeenId: lastId }
        : previous.atBottom ? { atBottom: false, lastSeenId: previous.lastSeenId } : previous);
    }}>
      {notice}
      {messages.length === 0 ? empty : groupMessages(messages).map((group) => (
        <section key={group[0].id} className={`message-group ${group[0].role}`} aria-label={group[0].role === 'user' ? 'Your messages' : `${agentName} messages`}>
          <div className="message-heading">
            <strong>{group[0].role === 'user' ? 'You' : agentName}</strong>
            <time dateTime={new Date(group[0].ts).toISOString()} title={new Date(group[0].ts).toLocaleString()}>
              {new Date(group[0].ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </time>
          </div>
          {group.map((message) => <div key={message.id} className={`msg ${message.role}`}>
            {messageParts(message.text).map((part, index) => part.kind === 'code'
              ? <div className="code-block" key={index}><span>{part.language || 'Code'}</span><pre><code>{part.text}</code></pre></div>
              : <p key={index}>{part.text}</p>)}
            {message.role === 'user' && message.outStatus && <div className={`delivery ${message.outStatus}`} role="status">
              <span aria-hidden="true">{message.outStatus === 'sent' ? '✓' : message.outStatus === 'failed' ? '!' : '◷'}</span>
              <strong>{message.outStatus === 'sent' ? 'Sent' : message.outStatus === 'failed' ? 'Not sent' : 'Queued'}</strong>
              {message.outStatus === 'failed' && <button onClick={() => onRetry(message)} disabled={retrying.includes(message.id)}>
                {retrying.includes(message.id) ? 'Retrying…' : 'Retry'}
              </button>}
              {message.outError && <p>{message.outError}</p>}
            </div>}
          </div>)}
        </section>
      ))}
    </div>
    {hasNew && !query && <button className="jump-latest" onClick={() => { scrollToLatest(); setPosition({ atBottom: true, lastSeenId: lastId }); }}>New messages ↓</button>}
  </div>;
}
