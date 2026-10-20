/** Types and channel names shared by main, preload and renderer. Types only plus constants. */
import type { Category } from './categories.ts';
import type { Settings } from './settings.ts';

export type ItemStatus = 'queued' | 'idle' | 'probing' | 'downloading' | 'verifying' | 'paused' | 'done' | 'error' | 'cancelled';

export interface ViewItem {
  id: string;
  url: string;
  name: string;
  dir: string;
  /** Final path, only once finished. */
  path: string | null;
  status: ItemStatus;
  /** Paused on purpose and waiting for "Start queue" (added with "Add to queue"). */
  held: boolean;
  size: number | null;
  downloaded: number;
  speed: number;
  eta: number | null;
  createdAt: string;
  error: string | null;
  connections: number;
  hadHeaders: boolean;
  category: Category;
}

export interface SegmentView {
  start: number;
  end: number;
  pos: number;
}

/** Live details for the one download the detail panel is watching. */
export interface DetailView {
  id: string;
  segments: SegmentView[];
  warnings: string[];
  /** Speed samples (bytes/s), oldest first, one about every 500 ms. */
  speedHistory: number[];
}

export interface ItemsBatch {
  upserts: ViewItem[];
  removed: string[];
}

export interface InitialState {
  items: ViewItem[];
  settings: Settings;
  version: string;
  packaged: boolean;
}

export interface ProbeInfo {
  fileName: string;
  size: number | null;
  resumable: boolean;
  mime: string | null;
}

export interface ProbeRequest {
  url: string;
  bridgeToken: string | null;
}

export interface AddRequest {
  url: string;
  fileName: string | null;
  /** null = the default folder (plus category subfolder if that setting is on). */
  dir: string | null;
  connections: number;
  /** true = start now, false = add to the queue (starts with "Start queue"). */
  start: boolean;
  bridgeToken: string | null;
}

export interface RemoveRequest {
  ids: string[];
  deleteFile: boolean;
}

/** Add-dialog prefill pushed by main (browser extension, clipboard offer). */
export interface AddPrefill {
  url: string;
  fileName: string | null;
  bridgeToken: string | null;
  /** True when the browser handed over a cookie for this download (value never leaves main). */
  hasCookie: boolean;
  source: 'bridge' | 'clipboard' | 'drop';
}

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export type ToastKind = 'info' | 'error' | 'success';
export interface ToastMessage {
  kind: ToastKind;
  /** Key in the strings table, or null to show text as it is. */
  key: string | null;
  text: string;
}

/** What the preload script exposes as window.sareea. */
export interface SareeaApi {
  getState(): Promise<InitialState>;
  /** Tell main the UI has registered its listeners; queued prefills and toasts are delivered now. */
  ready(): Promise<Result>;
  probe(req: ProbeRequest): Promise<Result<{ info: ProbeInfo }>>;
  add(req: AddRequest): Promise<Result<{ id: string }>>;
  pause(ids: string[]): Promise<Result>;
  resume(ids: string[]): Promise<Result>;
  remove(req: RemoveRequest): Promise<Result>;
  redownload(ids: string[]): Promise<Result>;
  openFile(id: string): Promise<Result>;
  openFolder(id: string): Promise<Result>;
  copyLink(id: string): Promise<Result>;
  startQueue(): Promise<Result>;
  stopQueue(): Promise<Result>;
  setSettings(patch: Partial<Settings>): Promise<Result<{ settings: Settings }>>;
  pickFolder(): Promise<Result<{ dir: string | null }>>;
  readClipboardUrl(): Promise<Result<{ url: string | null }>>;
  watch(id: string | null): Promise<Result>;
  onItems(cb: (batch: ItemsBatch) => void): () => void;
  onSettings(cb: (s: Settings) => void): () => void;
  onDetail(cb: (d: DetailView) => void): () => void;
  onShowAdd(cb: (p: AddPrefill) => void): () => void;
  onToast(cb: (t: ToastMessage) => void): () => void;
}

/** IPC channel names. Renderer to main (invoke) and main to renderer (send). */
export const CH = {
  getState: 'sareea:getState',
  ready: 'sareea:ready',
  probe: 'sareea:probe',
  add: 'sareea:add',
  pause: 'sareea:pause',
  resume: 'sareea:resume',
  remove: 'sareea:remove',
  redownload: 'sareea:redownload',
  openFile: 'sareea:openFile',
  openFolder: 'sareea:openFolder',
  copyLink: 'sareea:copyLink',
  startQueue: 'sareea:startQueue',
  stopQueue: 'sareea:stopQueue',
  setSettings: 'sareea:setSettings',
  pickFolder: 'sareea:pickFolder',
  readClipboardUrl: 'sareea:readClipboardUrl',
  watch: 'sareea:watch',
  evItems: 'sareea:ev:items',
  evSettings: 'sareea:ev:settings',
  evDetail: 'sareea:ev:detail',
  evShowAdd: 'sareea:ev:showAdd',
  evToast: 'sareea:ev:toast',
} as const;
