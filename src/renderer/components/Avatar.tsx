import { cx } from './cx';

export interface AvatarProps {
  name: string;
  active?: boolean;
}

/** Square monogram avatar that takes its colors from the tokens. */
export function Avatar({ name, active = false }: AvatarProps) {
  return (
    <span className={cx('ui-avatar', active && 'ui-avatar--active')} aria-hidden="true">
      {name.charAt(0)}
    </span>
  );
}
