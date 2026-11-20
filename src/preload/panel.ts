// Preload bridge for the blibs panel.
//
// The panel has no direct Electron access. It can ask the main process to open
// a vendor sign-in window and it receives the step for that window. The vendor
// window and its session stay in the main process.
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

contextBridge.exposeInMainWorld('blibsDesktop', { login });
