import type { ReactNode } from 'react';
import { cx } from './cx';

export type StatusTone = 'neutral' | 'live' | 'idle' | 'down';

export interface StatusPillProps {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
}

/** Compact status pill with a color dot. */
export function StatusPill({ tone, children, title }: StatusPillProps) {
  return (
    <div className={cx('sync-pill', 'ui-status-pill', `ui-status-pill--${tone}`)} title={title} role="status">
      <span className="ui-status-pill__dot" aria-hidden="true" />
      {children}
    </div>
  );
}
