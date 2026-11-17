import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cx } from './cx';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Accessible name for the input. */
  label: string;
  /** Hide the visible label and use `label` as the accessible name only. */
  hideLabel?: boolean;
}

/** Single-line text input with a visible or screen-reader-only label. */
export function TextField({
  label,
  hideLabel = false,
  id,
  className,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <label className={cx('ui-field', hideLabel && 'ui-field--bare')} htmlFor={inputId}>
      {hideLabel ? null : <span className="ui-field__label">{label}</span>}
      <input
        id={inputId}
        aria-label={hideLabel ? label : undefined}
        className={cx('ui-textfield', className)}
        {...props}
      />
    </label>
  );
}
