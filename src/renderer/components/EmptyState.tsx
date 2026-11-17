import { Card } from './Card';

export interface EmptyStateProps {
  title: string;
  steps?: string[];
}

/** Empty state card with an optional short list of steps. */
export function EmptyState({ title, steps = [] }: EmptyStateProps) {
  return (
    <Card className="empty">
      <p className="empty-title">{title}</p>
      {steps.length > 0 && (
        <ol>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
    </Card>
  );
}
