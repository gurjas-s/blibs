import { useId } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { cx } from './cx';

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Accessible name for the select. */
  label: string;
  /** Hide the visible label and use `label` as the accessible name only. */
  hideLabel?: boolean;
  children: ReactNode;
}

/** Native select with a visible or screen-reader-only label. */
export function SelectField({
  label,
  hideLabel = false,
  id,
  className,
  children,
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  return (
    <label className={cx('ui-field', hideLabel && 'ui-field--bare')} htmlFor={selectId}>
      {hideLabel ? null : <span className="ui-field__label">{label}</span>}
      <select
        id={selectId}
        aria-label={hideLabel ? label : undefined}
        className={cx('ui-select', className)}
        {...props}
      >
        {children}
      </select>
    </label>
  );
}
