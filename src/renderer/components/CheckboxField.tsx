import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type CheckboxVariant = 'checkbox' | 'switch';

export interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  /**
   * `checkbox` is the default control. `switch` shows the shared toggle track.
   * A switch keeps the native checkbox input and moves its label to a
   * screen-reader-only name.
   */
  variant?: CheckboxVariant;
}

/** Checkbox with an inline label and a visible focus ring on the wrapper. */
export function CheckboxField({
  label,
  variant = 'checkbox',
  className,
  ...props
}: CheckboxFieldProps) {
  if (variant === 'switch') {
    return (
      <label className={cx('ui-checkbox', 'ui-checkbox--switch', className)}>
        <input type="checkbox" {...props} />
        <span className="ui-switch__track" aria-hidden="true">
          <span className="ui-switch__thumb" />
        </span>
        <span className="sr-only">{label}</span>
      </label>
    );
  }

  return (
    <label className={cx('ui-checkbox', className)}>
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
