// Provider sign-in status controller. Provider pages open in the center pane.
import { session } from 'electron';

export type LoginPhase =
  | 'opening'
  | 'loading'
  | 'needs-sign-in'
  | 'needs-verification'
  | 'needs-captcha'
  | 'signed-in'
  | 'error'
  | 'closed';

export interface LoginStatus {
  vendorId: string;
  phase: LoginPhase;
  message: string;
  mock: boolean;
}

export interface LoginVendor {
  id: string;
  name: string;
  url: string;
  partition: string;
}

type StatusSink = (status: LoginStatus) => void;

const statuses = new Map<string, LoginStatus>();
let sink: StatusSink = () => {};
export const MOCK_LOGIN = process.env.BLIBS_MOCK_LOGIN === '1';
const SESSION_COOKIE = /(session|sess|auth|token|sid|login|user)/i;

/** Set the panel event sink. The main window owns the only panel renderer. */
export function setLoginStatusSink(next: StatusSink): void {
  sink = next;
}

/** Read the last status for one vendor, or null when no attempt ran. */
export function getLoginStatus(vendorId: string): LoginStatus | null {
  return statuses.get(vendorId) ?? null;
}

function emit(status: LoginStatus): LoginStatus {
  const previous = statuses.get(status.vendorId);
  statuses.set(status.vendorId, status);
  if (previous
    && previous.phase === status.phase
    && previous.message === status.message
    && previous.mock === status.mock) return status;
  try {
    sink(status);
  } catch {
    // The panel can close while a status changes.
  }
  return status;
}

function statusFor(vendor: LoginVendor, phase: LoginPhase, message: string): LoginStatus {
  return emit({ vendorId: vendor.id, phase, message, mock: MOCK_LOGIN });
}

async function hasSessionCookie(vendor: LoginVendor): Promise<boolean> {
  const host = new URL(vendor.url).hostname.replace(/^www\./, '');
  const cookies = await session.fromPartition(vendor.partition).cookies.get({ domain: host });
  return cookies.some((cookie) => SESSION_COOKIE.test(cookie.name));
}

/** Read the vendor session without opening another window. */
export async function probeVendorLogin(vendor: LoginVendor): Promise<LoginStatus | null> {
  if (MOCK_LOGIN) return statuses.get(vendor.id) ?? null;
  try {
    if (await hasSessionCookie(vendor)) {
      return statusFor(vendor, 'signed-in', `Signed in to ${vendor.name}. The session stays on this device.`);
    }
  } catch {
    return statuses.get(vendor.id) ?? null;
  }
  return null;
}

export function beginVendorLogin(vendor: LoginVendor): LoginStatus {
  return MOCK_LOGIN
    ? statusFor(vendor, 'needs-verification', `Enter the mobile verification code in the ${vendor.name} website, then select Check again.`)
    : statusFor(vendor, 'needs-sign-in', `Sign in to ${vendor.name}, then select Check again.`);
}

/** Close the sign-in flow in the panel. The provider website stays in blibs. */
export function cancelVendorLogin(vendor: LoginVendor): LoginStatus {
  return statusFor(vendor, 'closed', `Sign-in cancelled for ${vendor.name}. You can try again.`);
}

/** Re-read the session after the user signs in or completes verification. */
export async function checkVendorLogin(vendor: LoginVendor, url?: string): Promise<LoginStatus> {
  if (MOCK_LOGIN) {
    return statusFor(vendor, 'signed-in', `Signed in to ${vendor.name}. The session stays on this device.`);
  }
  if (url) {
    const page = new URL(url);
    const location = page.hostname + page.pathname;
    if (/(captcha|challenge)/i.test(location)) {
      return statusFor(vendor, 'needs-captcha', `Complete the CAPTCHA, then select Check again.`);
    }
    if (/(verify|verification|otp|2fa|two-factor)/i.test(location)) {
      return statusFor(vendor, 'needs-verification', `Complete verification, then select Check again.`);
    }
    if (page.origin !== new URL(vendor.url).origin || /(login|sign-?in|auth|sso)/i.test(location)) {
      return beginVendorLogin(vendor);
    }
  }
  const status = await probeVendorLogin(vendor);
  return status ?? statusFor(
    vendor,
    'needs-sign-in',
    `Sign in to ${vendor.name} in the blibs center pane, then select Check again.`,
  );
}
