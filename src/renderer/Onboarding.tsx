import { useEffect, useState } from 'react';
import { PROVIDERS } from './providers';
import { Button } from './components/Button';
import { Card } from './components/Card';
import { SelectField } from './components/SelectField';

export interface OnboardingResult {
  /** Open the agents screen for sign-in when true. */
  openLogin?: boolean;
  vendorId?: string;
}

export interface OnboardingProps {
  onFinish: (result: OnboardingResult) => void;
}

const STEPS = ['What blibs does', 'Connect a vendor', 'Sign in', 'Start'];

/** First-run steps. Skip is safe at every step that asks for setup. */
export default function Onboarding({ onFinish }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [vendorId, setVendorId] = useState<string>(PROVIDERS[0].id);
  const vendor = PROVIDERS.find((item) => item.id === vendorId) ?? PROVIDERS[0];
  const last = STEPS.length - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onFinish({});
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onFinish]);

  const skip = (): void => {
    if (step === 0) onFinish({});
    else setStep(last);
  };

  return (
    <div className="onboarding-screen" data-onboarding>
      <Card className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-brand">
          <span className="mark" aria-hidden="true">b</span>
          <strong>blibs</strong>
        </div>

        <ol className="onboarding-steps" aria-label="Setup steps">
          {STEPS.map((label, index) => (
            <li key={label} aria-current={index === step ? 'step' : undefined}>
              <span aria-hidden="true">{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        <div className="onboarding-body">
          {step === 0 && (
            <>
              <h1 id="onboarding-title">One window for your personal agents</h1>
              <p>
                blibs keeps your vendor sessions open inside the app. It collects
                their chats into one panel and sends your replies back to the
                real session.
              </p>
              <p>
                You need an account with at least one vendor: Meta Muse, OpenAI
                Dots, or xAI Grok.
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <h1 id="onboarding-title">Connect a vendor</h1>
              <p>
                Choose the vendor that you want to use first. You can connect the
                other two later from the agents screen.
              </p>
              <SelectField
                label="Vendor"
                value={vendorId}
                onChange={(event) => setVendorId(event.target.value)}
              >
                {PROVIDERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.vendor} {item.product}
                  </option>
                ))}
              </SelectField>
            </>
          )}

          {step === 2 && (
            <>
              <h1 id="onboarding-title">Sign in</h1>
              <p>
                Sign-in happens in a vendor window inside the app. The session
                stays on this device. If the vendor asks for a code or a CAPTCHA,
                blibs shows the next step in the agents screen.
              </p>
              <p className="onboarding-note">
                Selected vendor: {vendor.vendor} {vendor.product}
              </p>
            </>
          )}

          {step === 3 && (
            <>
              <h1 id="onboarding-title">Start</h1>
              <p>
                Your chats sync after sign-in. Open the composer to send a reply.
                Use Sync in Settings to set how often the panel collects new
                messages.
              </p>
              <p className="onboarding-note">
                Signs in to {vendor.vendor} {vendor.product} from the agents screen.
              </p>
            </>
          )}
        </div>

        <div className="onboarding-actions">
          <Button variant="ghost" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>
            Back
          </Button>
          <div className="onboarding-actions-end">
            {step < last && (
              <Button variant="ghost" onClick={skip}>
                Skip
              </Button>
            )}
            {step === 0 && (
              <Button variant="primary" onClick={() => setStep(1)}>
                Next
              </Button>
            )}
            {step === 1 && (
              <Button variant="primary" onClick={() => setStep(2)}>
                Next
              </Button>
            )}
            {step === 2 && (
              <Button
                variant="primary"
                onClick={() => onFinish({ openLogin: true, vendorId })}
              >
                Sign in to {vendor.product}
              </Button>
            )}
            {step === 3 && (
              <Button variant="primary" onClick={() => onFinish({})}>
                Start using blibs
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
