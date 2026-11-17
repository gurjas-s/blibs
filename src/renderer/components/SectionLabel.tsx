import type { ReactNode } from 'react';

export interface SectionLabelProps {
  children: ReactNode;
}

/** Small uppercase label for a group of controls. */
export function SectionLabel({ children }: SectionLabelProps) {
  return <p className="section-label">{children}</p>;
}
