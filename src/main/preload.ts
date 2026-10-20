/**
 * Preload script (sandboxed). Exposes one small, fixed API to the page as window.sareea.
 * No generic "invoke any channel" function is exposed: each method maps to exactly one channel, and every
 * channel name is a string literal at its call site (so the pairing with the handlers in src/main/main.ts can
 * be read, and checked by test/ipc-channels.test.ts). The main process validates every argument again.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { AddPrefill, DetailView, ItemsBatch, SareeaApi, ToastMessage } from '../app/api.ts';
import type { Settings } from '../app/settings.ts';

const nothing = (): void => undefined;

const api: SareeaApi = {
  getState: () => ipcRenderer.invoke('sareea:getState'),
  ready: () => ipcRenderer.invoke('sareea:ready'),
  probe: (req) => ipcRenderer.invoke('sareea:probe', req),
  add: (req) => ipcRenderer.invoke('sareea:add', req),
  pause: (ids) => ipcRenderer.invoke('sareea:pause', ids),
  resume: (ids) => ipcRenderer.invoke('sareea:resume', ids),
  remove: (req) => ipcRenderer.invoke('sareea:remove', req),
  redownload: (ids) => ipcRenderer.invoke('sareea:redownload', ids),
  openFile: (id) => ipcRenderer.invoke('sareea:openFile', id),
  openFolder: (id) => ipcRenderer.invoke('sareea:openFolder', id),
  copyLink: (id) => ipcRenderer.invoke('sareea:copyLink', id),
  startQueue: () => ipcRenderer.invoke('sareea:startQueue'),
  stopQueue: () => ipcRenderer.invoke('sareea:stopQueue'),
  setSettings: (patch) => ipcRenderer.invoke('sareea:setSettings', patch),
  pickFolder: () => ipcRenderer.invoke('sareea:pickFolder'),
  readClipboardUrl: () => ipcRenderer.invoke('sareea:readClipboardUrl'),
  watch: (id) => ipcRenderer.invoke('sareea:watch', id),
  getIntegration: () => ipcRenderer.invoke('sareea:getIntegration'),
  installIntegration: () => ipcRenderer.invoke('sareea:installIntegration'),
  removeIntegration: () => ipcRenderer.invoke('sareea:removeIntegration'),
  openExtensionFolder: () => ipcRenderer.invoke('sareea:openExtensionFolder'),
  onItems: (cb) => {
    if (typeof cb !== 'function') return nothing;
    const listener = (_e: IpcRendererEvent, v: ItemsBatch) => cb(v);
    ipcRenderer.on('sareea:ev:items', listener);
    return () => {
      ipcRenderer.removeListener('sareea:ev:items', listener);
    };
  },
  onSettings: (cb) => {
    if (typeof cb !== 'function') return nothing;
    const listener = (_e: IpcRendererEvent, v: Settings) => cb(v);
    ipcRenderer.on('sareea:ev:settings', listener);
    return () => {
      ipcRenderer.removeListener('sareea:ev:settings', listener);
    };
  },
  onDetail: (cb) => {
    if (typeof cb !== 'function') return nothing;
    const listener = (_e: IpcRendererEvent, v: DetailView) => cb(v);
    ipcRenderer.on('sareea:ev:detail', listener);
    return () => {
      ipcRenderer.removeListener('sareea:ev:detail', listener);
    };
  },
  onShowAdd: (cb) => {
    if (typeof cb !== 'function') return nothing;
    const listener = (_e: IpcRendererEvent, v: AddPrefill) => cb(v);
    ipcRenderer.on('sareea:ev:showAdd', listener);
    return () => {
      ipcRenderer.removeListener('sareea:ev:showAdd', listener);
    };
  },
  onToast: (cb) => {
    if (typeof cb !== 'function') return nothing;
    const listener = (_e: IpcRendererEvent, v: ToastMessage) => cb(v);
    ipcRenderer.on('sareea:ev:toast', listener);
    return () => {
      ipcRenderer.removeListener('sareea:ev:toast', listener);
    };
  },
};

contextBridge.exposeInMainWorld('sareea', Object.freeze(api));
