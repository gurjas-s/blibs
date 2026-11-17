import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type CardTone = 'default' | 'accent';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  children: ReactNode;
}

/** Raised surface with the shared border, radius, and elevation tokens. */
export function Card({ tone = 'default', className, children, ...props }: CardProps) {
  return (
    <div className={cx('ui-card', `ui-card--${tone}`, className)} {...props}>
      {children}
    </div>
  );
}
