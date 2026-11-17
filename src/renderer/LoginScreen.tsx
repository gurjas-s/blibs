import type { LoginStatus, ProviderMeta } from './types';
import { Avatar } from './components/Avatar';
import { Button } from './components/Button';
import { Card } from './components/Card';

export interface LoginScreenProps {
  vendors: ProviderMeta[];
  statuses: Record<string, LoginStatus>;
  desktopAvailable: boolean;
  onBack: () => void;
  onSignIn: (vendorId: string) => void;
  onCancel: (vendorId: string) => void;
  onCheck: (vendorId: string) => void;
}

function isWorking(status: LoginStatus | undefined): boolean {
  return status?.phase === 'opening' || status?.phase === 'loading';
}

function needsNextStep(status: LoginStatus | undefined): boolean {
  return status?.phase === 'needs-sign-in'
    || status?.phase === 'needs-verification'
    || status?.phase === 'needs-captcha';
}

function defaultMessage(status: LoginStatus | undefined): string {
  if (!status) return 'Not signed in. Select Sign in to open the vendor window.';
  return status.message;
}

function statusTone(status: LoginStatus | undefined): string {
  if (status?.phase === 'error') return 'login-status login-status--error';
  if (status?.phase === 'signed-in') return 'login-status login-status--done';
  return 'login-status';
}

/** Agents screen with the in-app vendor sign-in entry point. */
export default function LoginScreen({
  vendors,
  statuses,
  desktopAvailable,
  onBack,
  onSignIn,
  onCancel,
  onCheck,
}: LoginScreenProps) {
  return (
    <div className="login-screen">
      <div className="thread-head login-head">
        <div>
          <h1>Agents</h1>
          <p>Sign in to each vendor inside the app. The session stays on this device.</p>
        </div>
        <Button variant="secondary" onClick={onBack}>
          Back to chats
        </Button>
      </div>

      <div className="login-body">
        {!desktopAvailable && (
          <p className="login-status login-status--error" role="alert">
            Vendor sign-in needs the blibs desktop app.
          </p>
        )}

        {vendors.map((vendor) => {
          const status = statuses[vendor.id];
          const working = isWorking(status);
          const next = needsNextStep(status);
          const signedIn = status?.phase === 'signed-in';

          return (
            <Card className="login-vendor" key={vendor.id}>
              <div className="login-vendor-head">
                <Avatar name={vendor.product} />
                <div>
                  <h2>{vendor.product}</h2>
                  <p className="login-vendor-meta">
                    {vendor.vendor} · {vendor.blurb}
                  </p>
                </div>
              </div>

              <p
                className={statusTone(status)}
                role={status?.phase === 'error' ? 'alert' : 'status'}
                aria-live="polite"
              >
                {defaultMessage(status)}
              </p>

              <div className="login-actions">
                {working ? (
                  <Button
                    variant="secondary"
                    aria-label={`Cancel ${vendor.product} sign-in`}
                    onClick={() => onCancel(vendor.id)}
                  >
                    Cancel
                  </Button>
                ) : (
                  <>
                    {next && (
                      <Button
                        variant="primary"
                        aria-label={`Check ${vendor.product} sign-in again`}
                        onClick={() => onCheck(vendor.id)}
                      >
                        Check again
                      </Button>
                    )}
                    <Button
                      variant={next ? 'secondary' : 'primary'}
                      aria-label={next
                        ? `Open the ${vendor.product} sign-in window`
                        : `Sign in to ${vendor.product}`}
                      onClick={() => onSignIn(vendor.id)}
                    >
                      {next ? 'Open window' : signedIn ? 'Sign in again' : 'Sign in'}
                    </Button>
                    {next && (
                      <Button
                        variant="ghost"
                        aria-label={`Cancel ${vendor.product} sign-in`}
                        onClick={() => onCancel(vendor.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
