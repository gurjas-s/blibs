import { harnessName } from '../connections';
import type { ChatMessage, HarnessActionStatus } from '../types';
import { Button } from './Button';
import { Card } from './Card';
import { StatusPill } from './StatusPill';
import type { StatusTone } from './StatusPill';
import { cx } from './cx';

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Display name of the agent that owns this thread. */
  agentName: string;
  onRetry?: (outboxId: string) => void;
}

function actionTone(status: HarnessActionStatus): StatusTone {
  if (status === 'completed') return 'live';
  if (status === 'failed') return 'down';
  return 'idle';
}

function actionLabel(status: HarnessActionStatus): string {
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  return 'Running';
}

/** Chat message with an aligned role label, a timestamp, and a delivery receipt. */
export function MessageBubble({ message, agentName, onRetry }: MessageBubbleProps) {
  const showPending = message.role === 'user' && message.via === 'tab'
    && message.outStatus !== undefined && message.outStatus !== 'sent';
  const showSent = message.role === 'user' && message.via === 'tab' && message.outStatus === 'sent';
  const roleLabel = message.role === 'user' ? 'You' : (message.senderName ?? agentName);
  const time = new Date(message.ts);
  const fullTime = time.toLocaleString();

  if (message.action) {
    const action = message.action;
    const name = harnessName(action.harness);
    const label = actionLabel(action.status);
    return (
      <article
        className="msg agent action-msg"
        aria-label={`${name} action, ${label}, ${fullTime}`}
      >
        <Card className="action-card">
          <div className="action-head">
            <span className="action-name">{name}</span>
            <StatusPill tone={actionTone(action.status)}>{label}</StatusPill>
          </div>
          <p className="action-detail">{action.detail}</p>
          <time className="action-time" dateTime={time.toISOString()} title={fullTime}>
            {time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </time>
        </Card>
      </article>
    );
  }

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
