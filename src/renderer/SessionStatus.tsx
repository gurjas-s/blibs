import type { VendorSession } from './types';

function sessionLabel(session?: VendorSession): string {
  if (!session) return 'Checking session';
  if (session.state === 'ready') return 'Signed in';
  if (session.state === 'signed-out') return 'Sign-in needed';
  if (session.state === 'error') return 'Connection error';
  return 'Connecting';
}

export default function SessionStatus({ session }: { session?: VendorSession }) {
  return <span className={`session-status ${session?.state || 'loading'}`} title={session?.reason}>
    <span className="dot" aria-hidden="true" />
    {sessionLabel(session)}
  </span>;
}
