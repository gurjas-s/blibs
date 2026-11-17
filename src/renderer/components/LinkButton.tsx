import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type LinkButtonVariant = 'ghost' | 'secondary';

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: LinkButtonVariant;
  children: ReactNode;
}

/** Anchor that looks like a button and keeps the native link behavior. */
export function LinkButton({
  variant = 'ghost',
  className,
  children,
  ...props
}: LinkButtonProps) {
  return (
    <a className={cx('ui-link-button', `ui-link-button--${variant}`, className)} {...props}>
      {children}
    </a>
  );
}
