import type { ChatMessage } from '../types';
import { Button } from './Button';
import { cx } from './cx';

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Display name of the agent that owns this thread. */
  agentName: string;
  onRetry?: (outboxId: string) => void;
}

/** Chat message with an aligned role label, a timestamp, and a delivery receipt. */
export function MessageBubble({ message, agentName, onRetry }: MessageBubbleProps) {
  const showPending = message.role === 'user' && message.via === 'tab'
    && message.outStatus !== undefined && message.outStatus !== 'sent';
  const showSent = message.role === 'user' && message.via === 'tab' && message.outStatus === 'sent';
  const roleLabel = message.role === 'user' ? 'You' : agentName;
  const time = new Date(message.ts);
  const fullTime = time.toLocaleString();

  return (
    <article className={cx('msg', message.role)} aria-label={`${roleLabel}, ${fullTime}`}>
      <div className="msg-meta">
        <span className="msg-role">{roleLabel}</span>
        <time dateTime={time.toISOString()} title={fullTime}>
          {time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </time>
      </div>
      <div className="msg-bubble">
        <p>{message.text}</p>
        {showPending && (
          <span className={cx('receipt', message.outStatus)}>
            {message.outStatus === 'queued' ? 'Sending…' : 'Not delivered'}
            {message.outStatus === 'failed' && message.outId && onRetry && (
              <Button variant="ghost" size="sm" onClick={() => onRetry(message.outId as string)}>
                Retry
              </Button>
            )}
          </span>
        )}
        {showSent && <span className="receipt sent">Sent</span>}
      </div>
    </article>
  );
}
