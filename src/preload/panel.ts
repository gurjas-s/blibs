// Preload bridge for the blibs panel.
//
// The panel has no direct Electron access. It asks the main process to show a
// provider website in the center pane and receives sign-in status events.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

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

interface DesktopLoginApi {
  open: (vendorId: string) => Promise<LoginStatus>;
  cancel: (vendorId: string) => Promise<LoginStatus>;
  check: (vendorId: string) => Promise<LoginStatus>;
  status: (vendorId: string) => Promise<LoginStatus | null>;
  probe: (vendorId: string) => Promise<LoginStatus | null>;
  onStatus: (listener: (status: LoginStatus) => void) => () => void;
}

interface DesktopClipboardApi {
  writeText: (value: string) => Promise<void>;
}

interface DesktopProviderPaneApi {
  onBack: (listener: () => void) => () => void;
  show: (providerId: string, source?: string) => Promise<void>;
  hide: () => Promise<void>;
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
}

const login: DesktopLoginApi = {
  open: (vendorId) => ipcRenderer.invoke('blibs:login:open', vendorId) as Promise<LoginStatus>,
  cancel: (vendorId) => ipcRenderer.invoke('blibs:login:cancel', vendorId) as Promise<LoginStatus>,
  check: (vendorId) => ipcRenderer.invoke('blibs:login:check', vendorId) as Promise<LoginStatus>,
  status: (vendorId) => ipcRenderer.invoke('blibs:login:status', vendorId) as Promise<LoginStatus | null>,
  probe: (vendorId) => ipcRenderer.invoke('blibs:login:probe', vendorId) as Promise<LoginStatus | null>,
  onStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, status: LoginStatus): void => listener(status);
    ipcRenderer.on('blibs:login:status', handler);
    return () => {
      ipcRenderer.removeListener('blibs:login:status', handler);
    };
  },
};

const clipboard: DesktopClipboardApi = {
  writeText: (value) => ipcRenderer.invoke('blibs:clipboard:write', value) as Promise<void>,
};

const providerPane: DesktopProviderPaneApi = {
  onBack: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on('blibs:provider-pane:back', handler);
    return () => ipcRenderer.removeListener('blibs:provider-pane:back', handler);
  },
  show: (providerId, source) => ipcRenderer.invoke('blibs:provider-pane:show', providerId, source) as Promise<void>,
  hide: () => ipcRenderer.invoke('blibs:provider-pane:hide') as Promise<void>,
  setBounds: (bounds) => ipcRenderer.send('blibs:provider-pane:bounds', bounds),
};

contextBridge.exposeInMainWorld('blibsDesktop', { login, clipboard, providerPane });
