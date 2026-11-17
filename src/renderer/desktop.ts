/**
 * Typed access to the narrow desktop bridge from the panel preload.
 *
 * A browser-only build has no bridge. The login screen reports that state
 * inline instead of failing a screen.
 */
import type { LoginStatus } from './types';

function bridge(): Window['blibsDesktop'] {
  return window.blibsDesktop;
}

/** True when the panel runs inside the Electron shell. */
export function desktopLoginAvailable(): boolean {
  return Boolean(bridge()?.login);
}

function requireLogin() {
  const login = bridge()?.login;
  if (!login) throw new Error('Vendor sign-in needs the blibs desktop app.');
  return login;
}

export function openVendorLogin(vendorId: string): Promise<LoginStatus> {
  return requireLogin().open(vendorId);
}

export function cancelVendorLogin(vendorId: string): Promise<LoginStatus> {
  return requireLogin().cancel(vendorId);
}

export function checkVendorLogin(vendorId: string): Promise<LoginStatus> {
  return requireLogin().check(vendorId);
}

export function fetchLoginStatus(vendorId: string): Promise<LoginStatus | null> {
  return requireLogin().status(vendorId);
}

/** Subscribe to sign-in steps. Returns an unsubscribe function. */
export function subscribeLoginStatus(listener: (status: LoginStatus) => void): () => void {
  const login = bridge()?.login;
  if (!login) return () => {};
  return login.onStatus(listener);
}
