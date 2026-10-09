import { contextBridge, ipcRenderer } from 'electron';

// Expose only the two panel operations. The main process validates their sender.
contextBridge.exposeInMainWorld('blibs', {
  sessions: () => ipcRenderer.invoke('blibs:sessions'),
  signIn: (provider: string) => ipcRenderer.invoke('blibs:sign-in', provider),
});
