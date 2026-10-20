/**
 * Preload script (sandboxed). Exposes one small, fixed API to the page as window.sareea.
 * No generic "invoke any channel" function is exposed: each method maps to one channel, and the main
 * process validates every argument again (src/main/main.ts).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CH } from '../app/api.ts';
import type { SareeaApi } from '../app/api.ts';

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  if (typeof cb !== 'function') return () => undefined;
  const listener = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: SareeaApi = {
  getState: () => ipcRenderer.invoke(CH.getState),
  ready: () => ipcRenderer.invoke(CH.ready),
  probe: (req) => ipcRenderer.invoke(CH.probe, req),
  add: (req) => ipcRenderer.invoke(CH.add, req),
  pause: (ids) => ipcRenderer.invoke(CH.pause, ids),
  resume: (ids) => ipcRenderer.invoke(CH.resume, ids),
  remove: (req) => ipcRenderer.invoke(CH.remove, req),
  redownload: (ids) => ipcRenderer.invoke(CH.redownload, ids),
  openFile: (id) => ipcRenderer.invoke(CH.openFile, id),
  openFolder: (id) => ipcRenderer.invoke(CH.openFolder, id),
  copyLink: (id) => ipcRenderer.invoke(CH.copyLink, id),
  startQueue: () => ipcRenderer.invoke(CH.startQueue),
  stopQueue: () => ipcRenderer.invoke(CH.stopQueue),
  setSettings: (patch) => ipcRenderer.invoke(CH.setSettings, patch),
  pickFolder: () => ipcRenderer.invoke(CH.pickFolder),
  readClipboardUrl: () => ipcRenderer.invoke(CH.readClipboardUrl),
  watch: (id) => ipcRenderer.invoke(CH.watch, id),
  onItems: (cb) => subscribe(CH.evItems, cb),
  onSettings: (cb) => subscribe(CH.evSettings, cb),
  onDetail: (cb) => subscribe(CH.evDetail, cb),
  onShowAdd: (cb) => subscribe(CH.evShowAdd, cb),
  onToast: (cb) => subscribe(CH.evToast, cb),
};

contextBridge.exposeInMainWorld('sareea', Object.freeze(api));
