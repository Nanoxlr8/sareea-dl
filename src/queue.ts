import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Download } from './download.ts';
import type { DownloadOptions, DownloadState } from './download.ts';
import { parseHttpUrl } from './http.ts';
import { Limiter } from './throttle.ts';

export type QueueStatus = 'queued' | DownloadState;

/** Public, secret-free view of one queued download. */
export interface QueueItem {
  id: string;
  url: string;
  dir: string;
  fileName: string | null;
  /** Real file name once known (from the probe, or the final path), else null. */
  name: string | null;
  connections: number;
  expectedSha256: string | null;
  /** True if the caller supplied request headers (cookies, auth...). The values are never stored. */
  hadHeaders: boolean;
  headerNames: string[];
  status: QueueStatus;
  createdAt: string;
  downloaded: number;
  size: number | null;
  speed: number;
  eta: number | null;
  path: string | null;
  error: string | null;
}

export interface QueueConstructorOptions {
  /** JSON file used to remember the queue between runs. Omit for a memory-only queue. */
  persistPath?: string;
  /** Downloads running at the same time. Default 3. */
  maxConcurrent?: number;
  /** Combined speed limit for all downloads in bytes/s, 0 = unlimited. */
  limitBytesPerSec?: number;
}

interface Entry {
  item: QueueItem;
  options: DownloadOptions;
  download: Download | null;
  running: boolean;
}

const ACTIVE: QueueStatus[] = ['probing', 'downloading', 'verifying'];

/**
 * Runs several Downloads with a concurrency cap and one shared speed limiter.
 *
 * Events (all carry the item id): 'added' (QueueItem), 'removed' ({id}), 'state' ({id,state}),
 * 'settled' ({id,state}; a run ended: done, paused, error or cancelled, slot is free),
 * 'progress' ({id, ...ProgressInfo}), 'done' ({id,path,sha256,size}), 'warning' ({id,code,message}),
 * 'error' ({id,error}; only emitted if a listener exists).
 *
 * Persistence stores URL, target and status only. Header values are NOT written to disk:
 * after a restart, resume(id, headers) must be given the headers again.
 */
export class Queue extends EventEmitter {
  readonly limiter: Limiter;
  private _max: number;
  private readonly _persistPath: string | null;
  private readonly _entries = new Map<string, Entry>();
  private _persistTimer: NodeJS.Timeout | null = null;
  private _persistChain: Promise<void> = Promise.resolve();

  constructor(opts: QueueConstructorOptions = {}) {
    super();
    this._max = Math.max(1, Math.floor(opts.maxConcurrent ?? 3));
    this.limiter = new Limiter(opts.limitBytesPerSec ?? 0);
    this._persistPath = opts.persistPath ? path.resolve(opts.persistPath) : null;
    if (this._persistPath) this._load();
  }

  get maxConcurrent(): number {
    return this._max;
  }

  setMaxConcurrent(n: number): void {
    this._max = Math.max(1, Math.floor(n));
    this._schedule();
  }

  /** Global limit in bytes/s shared by every download that has no limiter of its own. 0 = unlimited. */
  setLimit(bytesPerSec: number): void {
    this.limiter.setLimit(bytesPerSec);
  }

  /** Queue a download; it starts as soon as a slot is free (or stays paused with flags.paused). Returns its id. */
  add(options: DownloadOptions, flags: { paused?: boolean } = {}): string {
    parseHttpUrl(options.url);
    if (!options.dir) throw new Error('dir is required');
    const id = randomUUID();
    const headerNames = Object.keys(options.headers ?? {});
    const item: QueueItem = {
      id,
      url: options.url,
      dir: path.resolve(options.dir),
      fileName: options.fileName ?? null,
      name: options.fileName ?? null,
      connections: options.connections ?? 8,
      expectedSha256: options.expectedSha256 ?? null,
      hadHeaders: headerNames.length > 0,
      headerNames,
      status: flags.paused ? 'paused' : 'queued',
      createdAt: new Date().toISOString(),
      downloaded: 0,
      size: null,
      speed: 0,
      eta: null,
      path: null,
      error: null,
    };
    this._entries.set(id, { item, options: { ...options, dir: item.dir }, download: null, running: false });
    this.emit('added', { ...item });
    this._changed();
    this._schedule();
    return id;
  }

  list(): QueueItem[] {
    return [...this._entries.values()].map((e) => ({ ...e.item, headerNames: [...e.item.headerNames] }));
  }

  get(id: string): QueueItem | null {
    const e = this._entries.get(id);
    return e ? { ...e.item, headerNames: [...e.item.headerNames] } : null;
  }

  async pause(id: string): Promise<void> {
    const e = this._need(id);
    if (e.running && e.download) {
      await e.download.pause();
    } else if (e.item.status === 'queued') {
      this._setStatus(e, 'paused');
    }
  }

  /** Put a paused, failed or cancelled item back in line. Headers (if any) must be supplied again after a restart. */
  resume(id: string, headers?: Record<string, string>): void {
    const e = this._need(id);
    if (e.item.status !== 'paused' && e.item.status !== 'error' && e.item.status !== 'cancelled') return;
    if (headers) {
      e.options = { ...e.options, headers: { ...headers } };
      e.download = null; // rebuild with the new headers; the sidecar carries the progress
    }
    e.item.error = null;
    this._setStatus(e, 'queued');
    this._schedule();
  }

  resumeAll(): void {
    for (const e of this._entries.values()) this.resume(e.item.id);
  }

  async cancel(id: string, deleteFiles = false): Promise<void> {
    const e = this._need(id);
    if (e.item.status === 'done') return;
    if (e.running && e.download) {
      await e.download.cancel(deleteFiles);
    } else {
      if (e.download) await e.download.cancel(deleteFiles);
      this._setStatus(e, 'cancelled');
    }
  }

  /** Cancel (keeping files unless deleteFiles) and forget the item. */
  async remove(id: string, deleteFiles = false): Promise<void> {
    const e = this._need(id);
    if (e.item.status !== 'done' && e.item.status !== 'cancelled') await this.cancel(id, deleteFiles);
    this._entries.delete(id);
    this.emit('removed', { id });
    this._changed();
  }

  /** Resolves when nothing is queued or running. */
  whenIdle(): Promise<void> {
    const busy = () => [...this._entries.values()].some((e) => e.running || e.item.status === 'queued');
    if (!busy()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!busy()) {
          this.off('state', check);
          this.off('settled', check);
          resolve();
        }
      };
      this.on('state', check);
      this.on('settled', check);
    });
  }

  /** Write the queue file now. Resolves when it is on disk. */
  flush(): Promise<void> {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    return this._writeNow();
  }

  // --------------------------------------------------------------- internals

  private _need(id: string): Entry {
    const e = this._entries.get(id);
    if (!e) throw new Error(`Unknown download id: ${id}`);
    return e;
  }

  private _setStatus(e: Entry, status: QueueStatus): void {
    e.item.status = status;
    this.emit('state', { id: e.item.id, state: status });
    this._changed();
  }

  private _schedule(): void {
    let running = 0;
    for (const e of this._entries.values()) if (e.running) running++;
    for (const e of this._entries.values()) {
      if (running >= this._max) break;
      if (e.item.status === 'queued' && !e.running) {
        this._launch(e);
        running++;
      }
    }
  }

  private _makeDownload(e: Entry): Download {
    const id = e.item.id;
    const d = new Download({ ...e.options, limiter: e.options.limiter ?? this.limiter });
    d.on('state', (s: DownloadState) => {
      if (d.fileName) e.item.name = d.fileName;
      this._setStatus(e, s);
    });
    d.on('progress', (p) => {
      e.item.downloaded = p.downloaded;
      e.item.size = p.size;
      e.item.speed = p.speed;
      e.item.eta = p.eta;
      this.emit('progress', { id, ...p });
    });
    d.on('warning', (w) => this.emit('warning', { id, ...w }));
    d.on('done', (info) => {
      e.item.path = info.path;
      e.item.name = path.basename(info.path);
      e.item.downloaded = info.size;
      e.item.size = info.size;
      e.item.speed = 0;
      e.item.eta = 0;
      this.emit('done', { id, ...info });
    });
    d.on('error', (err: Error) => {
      e.item.error = err.message;
      if (this.listenerCount('error') > 0) this.emit('error', { id, error: err });
    });
    return d;
  }

  private _launch(e: Entry): void {
    e.running = true;
    const d = (e.download ??= this._makeDownload(e));
    this._setStatus(e, 'probing');
    d.start().then(() => {
      e.running = false;
      if (e.item.status !== 'done') e.item.speed = 0;
      this._changed();
      this.emit('settled', { id: e.item.id, state: e.item.status });
      this._schedule();
    });
  }

  private _changed(): void {
    if (!this._persistPath || this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      void this._writeNow();
    }, 100);
  }

  private _writeNow(): Promise<void> {
    const target = this._persistPath;
    if (!target) return Promise.resolve();
    const json = JSON.stringify({ version: 1, items: this.list() }, null, 2);
    this._persistChain = this._persistChain.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const tmp = target + '.tmp';
        await fs.promises.writeFile(tmp, json);
        await fs.promises.rename(tmp, target);
      } catch {
        /* the queue keeps working in memory */
      }
    });
    return this._persistChain;
  }

  private _load(): void {
    let data: { items?: QueueItem[] };
    try {
      data = JSON.parse(fs.readFileSync(this._persistPath as string, 'utf8'));
    } catch {
      return;
    }
    for (const raw of data.items ?? []) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.url !== 'string' || typeof raw.dir !== 'string') continue;
      try {
        parseHttpUrl(raw.url);
      } catch {
        continue;
      }
      const wasLive = raw.status === 'queued' || ACTIVE.includes(raw.status);
      const item: QueueItem = {
        id: raw.id,
        url: raw.url,
        dir: raw.dir,
        fileName: raw.fileName ?? null,
        name: typeof raw.name === 'string' ? raw.name : raw.fileName ?? null,
        connections: raw.connections ?? 8,
        expectedSha256: raw.expectedSha256 ?? null,
        hadHeaders: !!raw.hadHeaders,
        headerNames: Array.isArray(raw.headerNames) ? raw.headerNames.map(String) : [],
        status: wasLive ? 'paused' : raw.status, // never auto-start after a restart
        createdAt: raw.createdAt ?? new Date().toISOString(),
        downloaded: raw.downloaded ?? 0,
        size: raw.size ?? null,
        speed: 0,
        eta: null,
        path: raw.path ?? null,
        error: raw.error ?? null,
      };
      const options: DownloadOptions = { url: item.url, dir: item.dir, connections: item.connections };
      if (item.fileName) options.fileName = item.fileName;
      if (item.expectedSha256) options.expectedSha256 = item.expectedSha256;
      this._entries.set(item.id, { item, options, download: null, running: false });
    }
  }
}
