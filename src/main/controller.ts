/**
 * The app's brain: owns the Queue, the settings and the small bits of state around them, and turns
 * validated UI requests into engine calls. It never imports Electron: everything that touches the OS
 * (open a file, clipboard, confirm dialogs) comes in through the Platform interface, so it can be
 * tested with plain Node.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Queue } from '../queue.ts';
import type { QueueItem } from '../queue.ts';
import { probe } from '../probe.ts';
import { fileNameFromUrl } from '../filename.ts';
import { redactUrl } from '../http.ts';
import { categoryOf, isRiskyFile, subfolderFor } from '../app/categories.ts';
import { sanitizeLoadedSettings, defaultSettings } from '../app/settings.ts';
import type { Settings } from '../app/settings.ts';
import { isDirAllowed } from '../app/ipc.ts';
import type { BridgeRequest } from '../app/protocol.ts';
import type {
  AddPrefill, AddRequest, DetailView, InitialState, ItemsBatch, ProbeInfo, ProbeRequest, RemoveRequest, Result, SegmentView, ViewItem,
} from '../app/api.ts';
import type { Logger } from './logger.ts';

/** OS actions, supplied by main.ts (Electron) or by a test. */
export interface Platform {
  /** Open a file with its default program. Resolves to '' on success or an error text. */
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
  writeClipboard(text: string): void;
  /** Ask the user before opening a program/script. */
  confirmRisky(fileName: string): Promise<boolean>;
}

export interface ControllerOptions {
  dataDir: string;
  userProfile: string;
  platform: Platform;
  log: Logger;
  /** Applied on top of the loaded settings (used by --self-test). */
  settingsOverride?: Partial<Settings>;
}

interface HeaderToken {
  headers: Record<string, string>;
  hasCookie: boolean;
  expires: number;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKENS = 50;
const FLUSH_MS = 200;
const HISTORY_LEN = 120;

const ACTIVE = ['probing', 'downloading', 'verifying'];

/**
 * Tag the finished file as downloaded from the internet ("Mark of the Web": the Zone.Identifier
 * stream, zone 3), so Windows SmartScreen and Office Protected View treat it with caution.
 * Only the origin and path of the link are stored, not the query string. Silently skipped where the
 * file system has no streams (FAT, some network shares).
 */
export async function markFromInternet(file: string, url: string, log?: Logger): Promise<void> {
  try {
    const host = redactUrl(url);
    await fs.promises.writeFile(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${host}\r\n`);
  } catch {
    log?.info('could not add the Zone.Identifier stream (file system without streams?)');
  }
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Events: 'batch' (ItemsBatch), 'detail' (DetailView), 'settings' (Settings), 'completed' (ViewItem),
 * 'prefill' (AddPrefill), 'toast' (key + text).
 */
export class AppController extends EventEmitter {
  readonly queue: Queue;
  settings: Settings;

  private readonly platform: Platform;
  private readonly log: Logger;
  private readonly settingsFile: string;
  private readonly metaFile: string;
  private readonly held = new Set<string>();
  private readonly pickedDirs = new Set<string>();
  private readonly tokens = new Map<string, HeaderToken>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private watched: string | null = null;
  private lastSegments: SegmentView[] = [];
  private speedHistory: number[] = [];
  private lastHistoryAt = 0;
  private warnings = new Map<string, string[]>();
  private writing: Promise<void> = Promise.resolve();

  constructor(opts: ControllerOptions) {
    super();
    this.platform = opts.platform;
    this.log = opts.log;
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.settingsFile = path.join(opts.dataDir, 'settings.json');
    this.metaFile = path.join(opts.dataDir, 'meta.json');

    const defaults = defaultSettings(opts.userProfile);
    let loaded: unknown = null;
    try {
      loaded = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {
      /* first run or unreadable: defaults */
    }
    this.settings = { ...sanitizeLoadedSettings(loaded, defaults), ...(opts.settingsOverride ?? {}) };

    try {
      const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) as { held?: unknown };
      if (Array.isArray(meta.held)) for (const id of meta.held) if (typeof id === 'string') this.held.add(id);
    } catch {
      /* none yet */
    }

    this.queue = new Queue({
      persistPath: path.join(opts.dataDir, 'queue.json'),
      maxConcurrent: this.settings.maxConcurrent,
      limitBytesPerSec: this.settings.speedLimitKiBps * 1024,
    });
    // Forget ids that no longer exist and items that cannot be "held" any more.
    const known = new Set(this.queue.list().map((i) => i.id));
    for (const id of [...this.held]) if (!known.has(id)) this.held.delete(id);
    this.hookQueue();
  }

  // ------------------------------------------------------------------ views

  private viewOf(item: QueueItem): ViewItem {
    const name = item.name ?? fileNameFromUrl(item.url) ?? 'download';
    return {
      id: item.id,
      url: item.url,
      name,
      dir: item.dir,
      path: item.status === 'done' ? item.path : null,
      status: item.status,
      held: item.status === 'paused' && this.held.has(item.id),
      size: item.size,
      downloaded: item.downloaded,
      speed: item.speed,
      eta: item.eta,
      createdAt: item.createdAt,
      error: item.error,
      connections: item.connections,
      hadHeaders: item.hadHeaders,
      category: categoryOf(name),
    };
  }

  getView(id: string): ViewItem | null {
    const it = this.queue.get(id);
    return it ? this.viewOf(it) : null;
  }

  getInitialState(version: string, packaged: boolean): InitialState {
    return { items: this.queue.list().map((i) => this.viewOf(i)), settings: { ...this.settings }, version, packaged };
  }

  // ---------------------------------------------------------- queue events

  private hookQueue(): void {
    const q = this.queue;
    const touch = (id: string) => this.markDirty(id);
    q.on('added', (i: QueueItem) => touch(i.id));
    q.on('state', ({ id }: { id: string }) => touch(id));
    q.on('settled', ({ id }: { id: string }) => {
      touch(id);
      if (id === this.watched) this.pushDetail();
    });
    q.on('removed', ({ id }: { id: string }) => {
      this.dirty.delete(id);
      this.removed.add(id);
      this.held.delete(id);
      this.warnings.delete(id);
      this.armFlush();
    });
    q.on('progress', (p: { id: string; segments: SegmentView[]; speed: number }) => {
      touch(p.id);
      if (p.id === this.watched) {
        this.lastSegments = p.segments.map((s) => ({ start: s.start, end: s.end, pos: s.pos }));
        const now = Date.now();
        if (now - this.lastHistoryAt >= 500) {
          this.lastHistoryAt = now;
          this.speedHistory.push(Math.round(p.speed));
          if (this.speedHistory.length > HISTORY_LEN) this.speedHistory.shift();
        }
      }
    });
    q.on('warning', (w: { id: string; code: string; message: string }) => {
      const list = this.warnings.get(w.id) ?? [];
      list.push(`${w.code}: ${w.message}`);
      this.warnings.set(w.id, list.slice(-5));
      this.log.warn(`download ${w.id.slice(0, 8)} warning ${w.code}`);
    });
    q.on('done', ({ id }: { id: string }) => {
      const v = this.getView(id);
      touch(id);
      if (v) {
        if (v.path) void markFromInternet(v.path, v.url, this.log);
        this.log.info(`download ${id.slice(0, 8)} finished: ${v.name}`);
        this.emit('completed', v);
      }
    });
    q.on('error', ({ id, error }: { id: string; error: Error }) => {
      this.log.error(`download ${id.slice(0, 8)} failed`, error);
    });
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
    this.armFlush();
  }

  private armFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBatch();
    }, FLUSH_MS);
  }

  private flushBatch(): void {
    const upserts: ViewItem[] = [];
    for (const id of this.dirty) {
      const v = this.getView(id);
      if (v) upserts.push(v);
    }
    this.dirty.clear();
    const removed = [...this.removed];
    this.removed.clear();
    if (upserts.length > 0 || removed.length > 0) {
      const batch: ItemsBatch = { upserts, removed };
      this.emit('batch', batch);
    }
    if (this.watched) this.pushDetail();
  }

  private pushDetail(): void {
    const id = this.watched;
    if (!id) return;
    const it = this.queue.get(id);
    if (!it) return;
    let segments = this.lastSegments;
    if (it.status === 'done' && segments.length > 0) segments = segments.map((s) => ({ start: s.start, end: s.end, pos: s.end + 1 }));
    else if (it.status === 'done' && it.size) segments = [{ start: 0, end: it.size - 1, pos: it.size }];
    else if (segments.length === 0 && it.size) segments = [{ start: 0, end: it.size - 1, pos: Math.min(it.downloaded, it.size) }];
    const d: DetailView = { id, segments, warnings: this.warnings.get(id) ?? [], speedHistory: [...this.speedHistory] };
    this.emit('detail', d);
  }

  watch(id: string | null): Result {
    if (id !== null && !this.queue.get(id)) return fail('unknown download');
    this.watched = id;
    this.lastSegments = [];
    this.speedHistory = [];
    if (id) this.pushDetail();
    return { ok: true };
  }

  // ---------------------------------------------------------------- settings

  /** Remember a folder the user picked in the folder dialog; the renderer may use it afterwards. */
  registerPickedDir(dir: string): void {
    this.pickedDirs.add(dir);
  }

  setSettings(patch: Partial<Settings>): Result<{ settings: Settings }> {
    if (patch.defaultDir !== undefined && patch.defaultDir !== this.settings.defaultDir) {
      if (!isDirAllowed(patch.defaultDir, this.settings.defaultDir, this.pickedDirs) || ![...this.pickedDirs].some((p) => p === patch.defaultDir)) {
        return fail('folder was not chosen with the folder dialog');
      }
    }
    this.settings = { ...this.settings, ...patch };
    if (patch.maxConcurrent !== undefined) this.queue.setMaxConcurrent(this.settings.maxConcurrent);
    if (patch.speedLimitKiBps !== undefined) this.queue.setLimit(this.settings.speedLimitKiBps * 1024);
    this.saveSettings();
    this.emit('settings', { ...this.settings });
    return { ok: true, settings: { ...this.settings } };
  }

  private saveSettings(): void {
    this.atomicWrite(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  private saveMeta(): void {
    this.atomicWrite(this.metaFile, JSON.stringify({ held: [...this.held] }));
  }

  private atomicWrite(file: string, text: string): void {
    this.writing = this.writing.then(async () => {
      try {
        await fs.promises.writeFile(file + '.tmp', text);
        await fs.promises.rename(file + '.tmp', file);
      } catch (e) {
        this.log.error('could not save ' + path.basename(file), e);
      }
    });
  }

  // ------------------------------------------------------- bridge header tokens

  private makeToken(headers: Record<string, string>): string {
    const now = Date.now();
    for (const [t, v] of this.tokens) if (v.expires < now) this.tokens.delete(t);
    while (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value as string);
    const token = randomBytes(18).toString('base64url');
    this.tokens.set(token, { headers, hasCookie: 'Cookie' in headers, expires: now + TOKEN_TTL_MS });
    return token;
  }

  private tokenHeaders(token: string | null, consume: boolean): Record<string, string> | undefined {
    if (!token) return undefined;
    const t = this.tokens.get(token);
    if (!t || t.expires < Date.now()) {
      this.tokens.delete(token);
      return undefined;
    }
    if (consume) this.tokens.delete(token);
    return t.headers;
  }

  // ------------------------------------------------------------------ actions

  async probeUrl(req: ProbeRequest): Promise<Result<{ info: ProbeInfo }>> {
    try {
      const headers = this.tokenHeaders(req.bridgeToken, false) ?? {};
      const r = await probe(req.url, headers, AbortSignal.timeout(20_000));
      return { ok: true, info: { fileName: r.fileName, size: r.size, resumable: r.acceptRanges && r.size !== null, mime: r.mime } };
    } catch (e) {
      this.log.warn(`probe failed for ${redactUrl(req.url)}: ${errorText(e)}`);
      return fail(errorText(e));
    }
  }

  resolveDir(requested: string | null, fileName: string | null, url: string): { ok: true; dir: string } | { ok: false; error: string } {
    if (requested !== null) {
      if (!isDirAllowed(requested, this.settings.defaultDir, this.pickedDirs)) return fail('folder was not chosen with the folder dialog');
      return { ok: true, dir: path.win32.normalize(requested) };
    }
    const base = this.settings.defaultDir;
    if (!this.settings.categorySubfolders) return { ok: true, dir: base };
    const cat = categoryOf(fileName ?? fileNameFromUrl(url));
    return { ok: true, dir: path.win32.join(base, subfolderFor(cat)) };
  }

  addDownload(req: AddRequest): Result<{ id: string }> {
    const duplicate = this.queue
      .list()
      .find((i) => i.url === req.url && i.status !== 'done' && i.status !== 'cancelled' && i.status !== 'error');
    if (duplicate) return fail('duplicate');
    const dir = this.resolveDir(req.dir, req.fileName, req.url);
    if (!dir.ok) return dir;
    const headers = this.tokenHeaders(req.bridgeToken, true);
    try {
      const id = this.queue.add(
        { url: req.url, dir: dir.dir, connections: req.connections, ...(req.fileName ? { fileName: req.fileName } : {}), ...(headers ? { headers } : {}) },
        { paused: !req.start },
      );
      if (!req.start) {
        this.held.add(id);
        this.saveMeta();
      }
      this.markDirty(id);
      this.log.info(`added ${redactUrl(req.url)} (${req.start ? 'start' : 'queued'}, ${req.connections} connections)`);
      return { ok: true, id };
    } catch (e) {
      return fail(errorText(e));
    }
  }

  async pause(ids: string[]): Promise<Result> {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.queue.pause(id);
        } catch {
          /* unknown id: ignore */
        }
      }),
    );
    return { ok: true };
  }

  resume(ids: string[]): Result {
    for (const id of ids) {
      const it = this.queue.get(id);
      if (!it) continue;
      if (it.status === 'paused' || it.status === 'error' || it.status === 'cancelled') {
        this.held.delete(id);
        this.queue.resume(id);
      }
    }
    this.saveMeta();
    return { ok: true };
  }

  startQueue(): Result {
    let n = 0;
    for (const it of this.queue.list()) {
      if (it.status === 'paused') {
        this.held.delete(it.id);
        this.queue.resume(it.id);
        n++;
      }
    }
    this.saveMeta();
    this.log.info(`start queue: ${n} item(s)`);
    return { ok: true };
  }

  async stopQueue(): Promise<Result> {
    const ids = this.queue.list().filter((i) => i.status === 'queued' || ACTIVE.includes(i.status)).map((i) => i.id);
    await this.pause(ids);
    return { ok: true };
  }

  async remove(req: RemoveRequest): Promise<Result> {
    for (const id of req.ids) {
      const it = this.queue.get(id);
      if (!it) continue;
      try {
        if (it.status === 'done') {
          if (req.deleteFile && it.path) {
            try {
              await fs.promises.unlink(it.path);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`could not delete ${path.basename(it.path)}: ${errorText(e)}`);
            }
          }
          await this.queue.remove(id, false);
        } else {
          await this.queue.remove(id, true); // unfinished: the partial data goes too
        }
      } catch (e) {
        this.log.error('remove failed', e);
      }
    }
    if (this.watched && !this.queue.get(this.watched)) this.watched = null;
    this.saveMeta();
    return { ok: true };
  }

  async redownload(ids: string[]): Promise<Result> {
    for (const id of ids) {
      const it = this.queue.get(id);
      if (!it) continue;
      const { url, dir, connections, name } = it;
      const override = it.fileName ?? name;
      await this.queue.remove(id, it.status !== 'done');
      this.held.delete(id);
      try {
        const nid = this.queue.add({ url, dir, connections, ...(override ? { fileName: override } : {}) });
        this.markDirty(nid);
      } catch (e) {
        this.log.error('redownload failed', e);
      }
    }
    this.saveMeta();
    return { ok: true };
  }

  async openFile(id: string): Promise<Result> {
    const it = this.queue.get(id);
    if (!it || it.status !== 'done' || !it.path) return fail('not a finished download');
    if (!fs.existsSync(it.path)) return fail('file-missing');
    const base = path.basename(it.path);
    if (isRiskyFile(base)) {
      const yes = await this.platform.confirmRisky(base);
      if (!yes) return fail('cancelled');
    }
    const err = await this.platform.openPath(it.path);
    return err ? fail(err) : { ok: true };
  }

  async openFolder(id: string): Promise<Result> {
    const it = this.queue.get(id);
    if (!it) return fail('unknown download');
    if (it.status === 'done' && it.path && fs.existsSync(it.path)) {
      this.platform.showItemInFolder(it.path);
      return { ok: true };
    }
    if (!fs.existsSync(it.dir)) return fail('file-missing');
    const err = await this.platform.openPath(it.dir);
    return err ? fail(err) : { ok: true };
  }

  copyLink(id: string): Result {
    const it = this.queue.get(id);
    if (!it) return fail('unknown download');
    this.platform.writeClipboard(it.url);
    return { ok: true };
  }

  // ------------------------------------------------------------------ bridge

  /**
   * A request from the browser bridge. With "start browser downloads without asking" on, the download
   * is added at once; otherwise the UI gets a prefilled Add dialog. The cookie stays in memory only.
   */
  async handleBridgeAdd(req: Extract<BridgeRequest, { type: 'add' }>): Promise<Result> {
    const headers: Record<string, string> = {};
    if (req.cookie) headers['Cookie'] = req.cookie;
    if (req.userAgent) headers['User-Agent'] = req.userAgent;
    const ref = req.referrer ?? req.pageUrl;
    if (ref) headers['Referer'] = ref;
    const token = this.makeToken(headers);
    if (!this.settings.browserAutoStart) {
      const prefill: AddPrefill = { url: req.url, fileName: req.fileName, bridgeToken: token, hasCookie: !!req.cookie, source: 'bridge' };
      this.emit('prefill', prefill);
      this.log.info(`browser handed over ${redactUrl(req.url)} (waiting for confirmation)`);
      return { ok: true };
    }
    let name = req.fileName;
    if (!name) {
      try {
        name = (await probe(req.url, headers, AbortSignal.timeout(10_000))).fileName;
      } catch {
        name = null; // the download itself will report the problem
      }
    }
    const r = this.addDownload({
      url: req.url, fileName: name, dir: null, connections: this.settings.defaultConnections, start: true, bridgeToken: token,
    });
    this.log.info(`browser download added automatically: ${redactUrl(req.url)}`);
    return r.ok ? { ok: true } : fail(r.error);
  }

  // ---------------------------------------------------------------- shutdown

  /** Pause everything cleanly (sidecars are flushed), then write the queue and the small files. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const live = this.queue.list().filter((i) => i.status === 'queued' || ACTIVE.includes(i.status));
    await Promise.all(live.map((i) => this.queue.pause(i.id).catch(() => undefined)));
    await this.queue.flush();
    this.saveMeta();
    this.saveSettings();
    await this.writing;
  }
}
