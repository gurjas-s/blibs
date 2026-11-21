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

export function cancelVendorLogin(vendorId: string): Promise<LoginStatus> {
  return requireLogin().cancel(vendorId);
}

export function checkVendorLogin(vendorId: string): Promise<LoginStatus> {
  return requireLogin().check(vendorId);
}

export function fetchLoginStatus(vendorId: string): Promise<LoginStatus | null> {
  return requireLogin().status(vendorId);
}

/** Read the vendor session without opening a window. */
export function probeVendorLogin(vendorId: string): Promise<LoginStatus | null> {
  return requireLogin().probe(vendorId);
}

/** Subscribe to sign-in steps. Returns an unsubscribe function. */
export function subscribeLoginStatus(listener: (status: LoginStatus) => void): () => void {
  const login = bridge()?.login;
  if (!login) return () => {};
  return login.onStatus(listener);
}

/** Copy text through Electron's native clipboard in the desktop app. */
export async function writeClipboardText(value: string): Promise<void> {
  const clipboard = window.blibsDesktop?.clipboard;
  if (clipboard) {
    await clipboard.writeText(value);
    return;
  }
  await navigator.clipboard.writeText(value);
}

/** Show a provider website in the blibs center pane. */
export function showProviderPane(providerId: string, source?: string): Promise<void> {
  const pane = window.blibsDesktop?.providerPane;
  if (!pane) return Promise.reject(new Error('Provider websites need the blibs desktop app.'));
  return pane.show(providerId, source);
}

/** Hide the provider website pane and return the Electron layer to the panel. */
export function hideProviderPane(): Promise<void> {
  return window.blibsDesktop?.providerPane.hide() ?? Promise.resolve();
}

/** Set the provider pane bounds from the panel layout. */
export function setProviderPaneBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  window.blibsDesktop?.providerPane.setBounds(bounds);
}

export function openVendorLogin(vendorId: string): Promise<LoginStatus> {
  return requireLogin().open(vendorId);
}

export function subscribeProviderPaneBack(listener: () => void): () => void {
  return window.blibsDesktop?.providerPane.onBack(listener) ?? (() => {});
}
