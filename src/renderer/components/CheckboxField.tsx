import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
}

/** Checkbox with an inline label and a visible focus ring on the wrapper. */
export function CheckboxField({ label, className, ...props }: CheckboxFieldProps) {
  return (
    <label className={cx('ui-checkbox', className)}>
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
