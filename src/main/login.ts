// Vendor sign-in controller.
//
// The panel asks the main process to open a sign-in window for a vendor. The
// window shares the persistent partition of the hidden sync view, so a
// completed sign-in feeds the session directly.
//
// The controller reports each step to the panel as an event. The panel shows
// the step inline. No panel screen depends on the vendor window, so the user
// can go back at any time.
import { BrowserWindow, session } from 'electron';

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
const windows = new Map<string, BrowserWindow>();
const mockTimers = new Map<string, NodeJS.Timeout[]>();
const pollTimers = new Map<string, NodeJS.Timeout>();
const attempts = new Map<string, number>();
let attemptSeq = 0;
let sink: StatusSink = () => {};

/** Use deterministic mock steps. The e2e harness sets BLIBS_MOCK_LOGIN=1. */
const MOCK_LOGIN = process.env.BLIBS_MOCK_LOGIN === '1';

/** Set the panel event sink. The main window owns the only panel renderer. */
export function setLoginStatusSink(next: StatusSink): void {
  sink = next;
}

/** Read the last status for one vendor, or null when no attempt ran. */
export function getLoginStatus(vendorId: string): LoginStatus | null {
  return statuses.get(vendorId) ?? null;
}

/** The open sign-in window for one vendor. The window is also a chat view. */
export function getVendorWindow(vendorId: string): BrowserWindow | null {
  const win = windows.get(vendorId);
  return win && !win.isDestroyed() ? win : null;
}

function emit(status: LoginStatus): LoginStatus {
  const previous = statuses.get(status.vendorId);
  statuses.set(status.vendorId, status);
  // The cookie poll repeats the same step. Do not wake the panel for it.
  if (previous
    && previous.phase === status.phase
    && previous.message === status.message
    && previous.mock === status.mock) {
    return status;
  }
  try {
    sink(status);
  } catch {
    // The panel can close during an attempt.
  }
  return status;
}

function statusFor(vendor: LoginVendor, phase: LoginPhase, message: string): LoginStatus {
  return emit({ vendorId: vendor.id, phase, message, mock: MOCK_LOGIN });
}

function clearMockTimers(vendorId: string): void {
  for (const timer of mockTimers.get(vendorId) ?? []) clearTimeout(timer);
  mockTimers.delete(vendorId);
}

function clearPollTimer(vendorId: string): void {
  const timer = pollTimers.get(vendorId);
  if (timer) clearInterval(timer);
  pollTimers.delete(vendorId);
}

/**
 * Re-read cookies while the sign-in window is open. A vendor can finish the
 * verification step without a new page load, so a load event alone can miss
 * the session. The poll stops after sign-in or when the window closes.
 */
function watchLogin(vendor: LoginVendor, win: BrowserWindow, attempt: number): void {
  clearPollTimer(vendor.id);
  const timer = setInterval(() => {
    if (win.isDestroyed() || attempts.get(vendor.id) !== attempt) {
      clearPollTimer(vendor.id);
      return;
    }
    if (statuses.get(vendor.id)?.phase === 'signed-in') {
      clearPollTimer(vendor.id);
      return;
    }
    const url = win.webContents.getURL();
    if (!url || url === 'about:blank') return;
    void inspectLogin(vendor, url);
  }, 2_000);
  timer.unref?.();
  pollTimers.set(vendor.id, timer);
}

function isLoginPath(url: string): boolean {
  return /(login|signin|sign-in|auth|sso|verify|verification|challenge|otp|code|2fa|two-factor|captcha)/i
    .test(url);
}

function isCaptchaPath(url: string): boolean {
  return /(captcha|challenge)/i.test(url);
}

function classifyUrl(vendor: LoginVendor, url: string): LoginStatus {
  if (isCaptchaPath(url)) {
    return statusFor(
      vendor,
      'needs-captcha',
      `Complete the CAPTCHA in the ${vendor.name} window, then select Check again.`,
    );
  }
  if (isLoginPath(url)) {
    return statusFor(
      vendor,
      'needs-verification',
      `Enter the code or verification step in the ${vendor.name} window, then select Check again.`,
    );
  }
  return statusFor(
    vendor,
    'needs-sign-in',
    `Finish signing in in the ${vendor.name} window, then select Check again.`,
  );
}

/** Read cookies after a page load. A vendor session cookie means sign-in worked. */
async function inspectLogin(vendor: LoginVendor, url: string): Promise<LoginStatus> {
  if (url && !isLoginPath(url)) {
    try {
      const host = new URL(vendor.url).hostname.replace(/^www\./, '');
      const cookies = await session.fromPartition(vendor.partition).cookies.get({ domain: host });
      const hasSession = cookies.some((cookie) =>
        /(session|auth|token|sid|login|user)/i.test(cookie.name),
      );
      if (hasSession) {
        return statusFor(vendor, 'signed-in', `Signed in to ${vendor.name}. The session stays on this device.`);
      }
    } catch {
      // Use the URL result when the cookie store is not ready.
    }
  }
  return classifyUrl(vendor, url);
}

function mockOpen(vendor: LoginVendor): LoginStatus {
  const first = statusFor(vendor, 'opening', `Opening the ${vendor.name} sign-in window…`);
  const timers = [
    setTimeout(() => {
      statusFor(vendor, 'loading', `Loading the ${vendor.name} sign-in page…`);
    }, 80),
    setTimeout(() => {
      statusFor(
        vendor,
        'needs-verification',
        `Enter the mobile verification code in the ${vendor.name} window, then select Check again.`,
      );
      mockTimers.delete(vendor.id);
    }, 220),
  ];
  mockTimers.set(vendor.id, timers);
  return first;
}

/** Open a vendor sign-in window. The tray menu and the panel use this path. */
export function openVendorLogin(vendor: LoginVendor, source?: string, preload?: string): LoginStatus {
  const attempt = attemptSeq++;
  attempts.set(vendor.id, attempt);
  clearMockTimers(vendor.id);
  clearPollTimer(vendor.id);

  const existing = windows.get(vendor.id);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return statuses.get(vendor.id) ?? statusFor(vendor, 'loading', `The ${vendor.name} sign-in window is open.`);
  }

  if (MOCK_LOGIN) return mockOpen(vendor);

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `${vendor.name} — sign in`,
    backgroundColor: '#101216',
    webPreferences: {
      partition: vendor.partition,
      // The popout is a chat view that must keep scraping while the panel has focus.
      backgroundThrottling: false,
      ...(preload ? { preload } : {}),
    },
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[blibs] ${vendor.name} preload failed at ${preloadPath}: ${error.message}`);
  });
  windows.set(vendor.id, win);
  statusFor(vendor, 'opening', `Opening the ${vendor.name} sign-in window…`);
  watchLogin(vendor, win, attempt);

  win.webContents.on('did-start-loading', () => {
    if (attempts.get(vendor.id) !== attempt) return;
    statusFor(vendor, 'loading', `Loading the ${vendor.name} sign-in page…`);
  });
  win.webContents.on('did-finish-load', () => {
    if (attempts.get(vendor.id) !== attempt) return;
    if (win.isDestroyed()) return;
    void inspectLogin(vendor, win.webContents.getURL());
  });
  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (attempts.get(vendor.id) !== attempt || !isMainFrame || code === -3) return;
    statusFor(
      vendor,
      'error',
      `The ${vendor.name} sign-in page did not load: ${description}. Check the network and try again.`,
    );
  });
  win.on('closed', () => {
    if (windows.get(vendor.id) === win) windows.delete(vendor.id);
    clearPollTimer(vendor.id);
    if (attempts.get(vendor.id) !== attempt) return;
    const current = statuses.get(vendor.id);
    if (current?.phase === 'signed-in') return;
    statusFor(vendor, 'closed', `The ${vendor.name} sign-in window closed. You can open it again.`);
  });

  void win.loadURL(source || vendor.url);
  return statuses.get(vendor.id) as LoginStatus;
}

/** Close a vendor sign-in window and report the result inline. */
export function cancelVendorLogin(vendor: LoginVendor): LoginStatus {
  attempts.set(vendor.id, attemptSeq++);
  clearMockTimers(vendor.id);
  clearPollTimer(vendor.id);
  const win = windows.get(vendor.id);
  if (win && !win.isDestroyed()) {
    win.close();
    windows.delete(vendor.id);
  }
  return statusFor(vendor, 'closed', `Sign-in cancelled for ${vendor.name}. You can try again.`);
}

/**
 * Re-read the sign-in state. Use it after a verification code or CAPTCHA.
 * The mock path completes the mocked sign-in.
 */
export async function checkVendorLogin(vendor: LoginVendor): Promise<LoginStatus> {
  clearMockTimers(vendor.id);
  if (MOCK_LOGIN) {
    statusFor(vendor, 'loading', `Checking the ${vendor.name} sign-in…`);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    return statusFor(vendor, 'signed-in', `Signed in to ${vendor.name}. The session stays on this device.`);
  }

  const win = windows.get(vendor.id);
  if (!win || win.isDestroyed()) {
    return statusFor(vendor, 'closed', `The ${vendor.name} sign-in window is closed. Open it again to continue.`);
  }
  return inspectLogin(vendor, win.webContents.getURL());
}

/** Close every sign-in window. Used at shutdown. */
export function closeLoginWindows(): void {
  for (const [vendorId, win] of windows) {
    if (!win.isDestroyed()) win.close();
    windows.delete(vendorId);
    clearMockTimers(vendorId);
    clearPollTimer(vendorId);
  }
}
