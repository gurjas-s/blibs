import type { ChatMessage } from '../types';
import { Button } from './Button';
import { cx } from './cx';

export interface MessageBubbleProps {
  message: ChatMessage;
  onRetry?: (outboxId: string) => void;
}

/** Chat bubble with the optional delivery receipt for session-routed replies. */
export function MessageBubble({ message, onRetry }: MessageBubbleProps) {
  const showPending = message.role === 'user' && message.via === 'tab'
    && message.outStatus !== undefined && message.outStatus !== 'sent';
  const showSent = message.role === 'user' && message.via === 'tab' && message.outStatus === 'sent';

  return (
    <div className={cx('msg', message.role)} title={new Date(message.ts).toLocaleString()}>
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
  );
}
