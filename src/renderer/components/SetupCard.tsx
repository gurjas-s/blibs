import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Card } from './Card';

export interface SetupCardProps {
  /** Product name of the assistant, such as `Grok`. */
  assistantName: string;
  /** The link that the user pastes into the assistant connector. */
  connectLink: string;
  /** True when the panel runs inside the desktop app. */
  desktopAvailable: boolean;
  /** True while the panel reads the login state. */
  checking: boolean;
  /** Last error from the desktop bridge. */
  error?: string;
  onCheck: () => void;
  onOpen: () => void;
}

interface SetupStep {
  title: string;
  detail: string;
  extra?: ReactNode;
}

/** Inline steps that connect one assistant to blibs. */
export function SetupCard({
  assistantName,
  connectLink,
  desktopAvailable,
  checking,
  error,
  onCheck,
  onOpen,
}: SetupCardProps) {
  const titleId = useId();
  const [copyStatus, setCopyStatus] = useState('');

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(connectLink);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Select the link and copy it.');
    }
  }

  const steps: SetupStep[] = [
    {
      title: `Open ${assistantName} → Connect apps`,
      detail: `Select the connector option in ${assistantName}.`,
    },
    {
      title: 'Paste your blibs link',
      detail: 'Add the link to the connector.',
      extra: (
        <span className="link-box">
          <code className="link-box__value">{connectLink}</code>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Copy the ${assistantName} connect link`}
            onClick={() => void copyLink()}
          >
            Copy
          </Button>
          <span className="sr-only" role="status">{copyStatus}</span>
        </span>
      ),
    },
    {
      title: 'Sign in to finish',
      detail: `Approve access in the ${assistantName} window, then select Check connection.`,
    },
  ];

  return (
    <Card className="setup-card" role="region" aria-labelledby={titleId}>
      <div className="setup-head">
        <h2 id={titleId}>Connect {assistantName} to blibs</h2>
        <p>{assistantName} needs one link before it can use the harnesses on this Mac.</p>
      </div>

      <ol className="setup-steps">
        {steps.map((step, index) => (
          <li className="setup-step" key={step.title}>
            <span className="setup-step__num" aria-hidden="true">{index + 1}</span>
            <div className="setup-step__text">
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
              {step.extra}
            </div>
          </li>
        ))}
      </ol>

      {!desktopAvailable && (
        <p className="setup-notice" role="alert">
          Vendor connections need the blibs desktop app.
        </p>
      )}
      {error && <p className="setup-notice" role="alert">{error}</p>}

      <div className="setup-actions">
        <Button
          variant="primary"
          disabled={!desktopAvailable || checking}
          onClick={onCheck}
        >
          {checking ? 'Checking…' : 'Check connection'}
        </Button>
        <Button
          variant="secondary"
          disabled={!desktopAvailable}
          onClick={onOpen}
        >
          Open {assistantName}
        </Button>
      </div>
    </Card>
  );
}
