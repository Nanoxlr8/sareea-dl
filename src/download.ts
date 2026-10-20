import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { httpRequest, HttpStatusError, isTransientError, parseHttpUrl, parseRetryAfter, TransientError } from './http.ts';
import type { HttpResponse } from './http.ts';
import { numberedName, sanitizeFileName, uniqueName } from './filename.ts';
import { parseContentRange, probe } from './probe.ts';
import type { ProbeResult } from './probe.ts';
import { downloadedBytes, MiB, remaining, splitInitial, stealWork, validateSegments } from './segments.ts';
import type { Segment } from './segments.ts';
import type { Limiter } from './throttle.ts';

export type DownloadState = 'idle' | 'probing' | 'downloading' | 'verifying' | 'paused' | 'done' | 'error' | 'cancelled';

export interface DownloadOptions {
  url: string;
  dir: string;
  /** Overrides the name suggested by the server. */
  fileName?: string;
  /** Parallel connections, 1..32. Default 8. */
  connections?: number;
  /** Extra request headers (Cookie, Referer, User-Agent, ...). Values are never logged or persisted. */
  headers?: Record<string, string>;
  /** Shared speed limiter. */
  limiter?: Limiter;
  /** Hex SHA-256 the finished file must match. */
  expectedSha256?: string;
  /** Do not split segments smaller than this many bytes. Default 1 MiB. */
  stealMinSize?: number;
  /** Smallest initial segment. Default 256 KiB. */
  minSegmentSize?: number;
  /** Consecutive failed attempts per segment before giving up. Default 5. */
  maxTries?: number;
  /** First retry delay (doubles each time, capped at 30 s). Default 500 ms. */
  retryBaseDelayMs?: number;
  /** Abort an attempt after this long without data. Default 30000 ms. */
  idleTimeoutMs?: number;
}

export interface ProgressInfo {
  downloaded: number;
  size: number | null;
  /** Smoothed bytes per second. */
  speed: number;
  /** Seconds, or null if unknown. */
  eta: number | null;
  segments: Segment[];
}

export interface DoneInfo {
  path: string;
  sha256: string;
  size: number;
}

export interface WarningInfo {
  code: string;
  message: string;
}

interface Sidecar {
  version: 1;
  url: string;
  fileName: string;
  size: number | null;
  etag: string | null;
  lastModified: string | null;
  resumable: boolean;
  segments: Segment[];
  downloaded: number;
  updatedAt: string;
}

type SidecarRead = { kind: 'none' } | { kind: 'corrupt' } | { kind: 'ok'; data: Sidecar };

class RangeUnsupportedError extends Error {
  constructor() {
    super('Server answered a ranged request with a full 200 response');
    this.name = 'RangeUnsupportedError';
  }
}

class RemoteChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteChangedError';
  }
}

const UNKNOWN_END = Number.MAX_SAFE_INTEGER;
const activeParts = new Set<string>();
let renameChain: Promise<unknown> = Promise.resolve();

function withRenameLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = renameChain.then(fn, fn);
  renameChain = run.catch(() => undefined);
  return run;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function readSidecar(file: string): SidecarRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'corrupt' };
  }
  try {
    const d = JSON.parse(text) as Sidecar;
    if (d && d.version === 1 && typeof d.url === 'string') return { kind: 'ok', data: d };
  } catch {
    /* fall through */
  }
  return { kind: 'corrupt' };
}

async function sha256File(file: string, signal: AbortSignal): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal, highWaterMark: 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows virus scanners briefly lock freshly written files.
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

/**
 * One file download: probe, split into segments, fetch them in parallel into
 * "<name>.part", persist progress in "<name>.sareea.json", verify and rename.
 *
 * Events: 'state' (DownloadState), 'progress' (ProgressInfo), 'warning' ({code,message}),
 * 'done' ({path, sha256, size}), 'error' (Error; only emitted if a listener exists).
 */
export class Download extends EventEmitter {
  readonly url: string;
  readonly dir: string;
  state: DownloadState = 'idle';
  error: Error | null = null;
  /** Final path once done. */
  path: string | null = null;
  sha256: string | null = null;
  /** 'multi' = ranged parallel download, 'single' = one plain connection (no resume). */
  mode: 'multi' | 'single' | null = null;
  resumable = false;
  speed = 0;
  /** Network counters for this object's lifetime. bytesFetched = bytes read from sockets. */
  stats = { bytesFetched: 0, requests: 0 };

  private readonly opts: DownloadOptions;
  private readonly connections: number;
  private readonly headers: Record<string, string>;
  private readonly limiter: Limiter | null;
  private readonly expectedSha256: string | null;
  private readonly maxTries: number;
  private readonly retryBaseDelayMs: number;
  private readonly idleTimeoutMs: number;
  private readonly stealMinSize: number;
  private readonly minSegmentSize: number;

  private _run: Promise<DownloadState> | null = null;
  private _ctrl: AbortController = new AbortController();
  private _stopReason: 'pause' | 'cancel' | null = null;
  private _deleteOnCancel = false;
  private _failure: Error | null = null;
  private _restarts = 0;

  private _size: number | null = null;
  private _etag: string | null = null;
  private _lastModified: string | null = null;
  private _baseName = '';
  private _partPath: string | null = null;
  private _sidecarPath: string | null = null;
  private _fh: FileHandle | null = null;
  private _segments: Segment[] = [];
  private _active = new Set<Segment>();
  private _inflight = new Map<Segment, number>();
  private _downloaded = 0;
  private _dirty = false;
  private _sidecarChain: Promise<void> = Promise.resolve();

  private _timer: NodeJS.Timeout | null = null;
  private _tickCount = 0;
  private _lastTickAt = 0;
  private _lastTickBytes = 0;

  constructor(options: DownloadOptions) {
    super();
    parseHttpUrl(options.url);
    if (!options.dir) throw new Error('dir is required');
    this.opts = options;
    this.url = options.url;
    this.dir = path.resolve(options.dir);
    this.connections = Math.min(32, Math.max(1, Math.floor(options.connections ?? 8)));
    this.headers = { ...(options.headers ?? {}) };
    this.limiter = options.limiter ?? null;
    if (options.expectedSha256 !== undefined) {
      const hex = options.expectedSha256.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('expectedSha256 must be 64 hex characters');
      this.expectedSha256 = hex;
    } else {
      this.expectedSha256 = null;
    }
    this.maxTries = Math.max(1, options.maxTries ?? 5);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30000;
    this.stealMinSize = options.stealMinSize ?? MiB;
    this.minSegmentSize = options.minSegmentSize ?? 256 * 1024;
  }

  // ---------------------------------------------------------------- public API

  /** True if request headers (cookies etc.) were supplied. Never exposes their values. */
  get hasHeaders(): boolean {
    return Object.keys(this.headers).length > 0;
  }

  /** Path of the .part file once known. */
  get partPath(): string | null {
    return this._partPath;
  }

  /**
   * Start, or resume from the sidecar. The promise resolves with the final state when this
   * run ends (done, paused, error or cancelled); it never rejects. Errors go to the 'error' event.
   */
  start(): Promise<DownloadState> {
    if (this._run) return this._run;
    if (this.state === 'done') return Promise.resolve('done');
    this._stopReason = null;
    this._deleteOnCancel = false;
    const p = Promise.resolve()
      .then(() => this._runInner())
      .finally(() => {
        this._run = null;
      });
    this._run = p;
    return p;
  }

  /** Stop all connections, flush the sidecar. Resolves once paused. Call start() to resume. */
  async pause(): Promise<void> {
    const run = this._run;
    if (!run) return;
    if (!this._stopReason) {
      this._stopReason = 'pause';
      this._ctrl.abort();
    }
    await run;
  }

  /** Stop and mark cancelled. With deleteFiles the .part and sidecar are removed. */
  async cancel(deleteFiles = false): Promise<void> {
    const run = this._run;
    if (!run) {
      if (deleteFiles) this._removeFiles();
      if (this.state !== 'done' && this.state !== 'cancelled') this._setState('cancelled');
      return;
    }
    this._stopReason = 'cancel';
    this._deleteOnCancel = this._deleteOnCancel || deleteFiles;
    this._ctrl.abort();
    await run;
  }

  getProgress(): ProgressInfo {
    const size = this._size;
    const eta = size !== null && this.speed > 1 ? Math.max(0, (size - this._downloaded) / this.speed) : null;
    return {
      downloaded: this._downloaded,
      size,
      speed: this.speed,
      eta,
      segments: this._segments.map((s) => ({ ...s })),
    };
  }

  // ------------------------------------------------------------------ internals

  private _setState(s: DownloadState): void {
    this.state = s;
    this.emit('state', s);
  }

  private _warn(code: string, message: string): void {
    this.emit('warning', { code, message } satisfies WarningInfo);
  }

  private _newCtrl(): AbortController {
    const c = new AbortController();
    this._ctrl = c;
    if (this._stopReason) c.abort();
    return c;
  }

  private async _runInner(): Promise<DownloadState> {
    this._failure = null;
    this._restarts = 0;
    this._segments = [];
    this._active.clear();
    this._inflight.clear();
    this._downloaded = 0;
    this._dirty = false;
    this.speed = 0;
    this.error = null;
    this._newCtrl();
    this._setState('probing');
    try {
      await this._prepare();
      if (this._stopReason) return await this._finishStopped();
      this._setState('downloading');
      this._startTimers();
      for (;;) {
        if (this._stopReason) break;
        const outcome = await this._transfer();
        if (outcome === 'restart') continue;
        if (outcome === 'complete') {
          await this._finalize();
          return 'done';
        }
        break;
      }
      return await this._finishStopped();
    } catch (e) {
      if (this._stopReason) return await this._finishStopped();
      this.error = toError(e);
      this._stopTimers();
      await this._closeFile();
      await this._flushSidecar();
      this._setState('error');
      if (this.listenerCount('error') > 0) this.emit('error', this.error);
      return 'error';
    } finally {
      this._stopTimers();
      await this._closeFile();
      if (this._partPath) activeParts.delete(this._partPath);
    }
  }

  private async _finishStopped(): Promise<DownloadState> {
    this._stopTimers();
    await this._closeFile(true);
    if (this._stopReason === 'cancel') {
      if (this._deleteOnCancel) {
        await this._sidecarChain;
        this._removeFiles();
      } else {
        await this._flushSidecar();
      }
      this._setState('cancelled');
      return 'cancelled';
    }
    await this._flushSidecar();
    this._setState('paused');
    return 'paused';
  }

  private _removeFiles(): void {
    for (const f of [this._partPath, this._sidecarPath, this._sidecarPath ? this._sidecarPath + '.tmp' : null]) {
      if (!f) continue;
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private async _closeFile(sync = false): Promise<void> {
    const fh = this._fh;
    this._fh = null;
    if (!fh) return;
    if (sync) await fh.sync().catch(() => undefined);
    await fh.close().catch(() => undefined);
  }

  // ------------------------------------------------------------------ prepare

  private _backoff(attempt: number, err: unknown): number {
    if (err instanceof HttpStatusError && err.retryAfterMs !== null) return err.retryAfterMs;
    const base = Math.min(30000, this.retryBaseDelayMs * 2 ** (attempt - 1));
    return base * (0.8 + Math.random() * 0.4);
  }

  private async _withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const signal = this._ctrl.signal;
        if (signal.aborted || !isTransientError(e) || attempt >= this.maxTries) throw e;
        await sleep(this._backoff(attempt, e), signal);
        if (signal.aborted) throw e;
      }
    }
  }

  private _applyProbe(p: ProbeResult): void {
    this._size = p.size;
    this._etag = p.etag;
    this._lastModified = p.lastModified;
    const canRange = p.acceptRanges && p.size !== null;
    this.mode = canRange ? 'multi' : 'single';
    this.resumable = canRange;
    if (!canRange) {
      this._warn(
        'single-connection',
        p.size === null
          ? 'Server did not report a file size: using a single connection, no resume.'
          : 'Server does not support byte ranges: using a single connection, no resume.',
      );
    }
  }

  private _initSegments(): Segment[] {
    if (this.mode === 'multi') return splitInitial(this._size as number, this.connections, this.minSegmentSize);
    return this._size !== null ? [{ start: 0, end: this._size - 1, pos: 0 }] : [];
  }

  private async _prepare(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const p = await this._withRetry(() => probe(this.url, this.headers, this._ctrl.signal));
    if (this._stopReason) return;
    this._applyProbe(p);
    this._baseName = sanitizeFileName(this.opts.fileName ?? p.fileName);

    // Pick the .part name: reuse our own sidecar for this URL, never touch somebody else's files.
    let saved: Sidecar | null = null;
    for (let i = 0; ; i++) {
      const name = i === 0 ? this._baseName : numberedName(this._baseName, i);
      const part = path.join(this.dir, name + '.part');
      const side = path.join(this.dir, name + '.sareea.json');
      if (activeParts.has(part)) continue;
      const sc = readSidecar(side);
      if (sc.kind === 'ok') {
        if (sc.data.url !== this.url) continue;
        saved = sc.data;
      } else if (sc.kind === 'corrupt' || fs.existsSync(part)) {
        continue;
      }
      this._partPath = part;
      this._sidecarPath = side;
      break;
    }
    activeParts.add(this._partPath as string);

    let resume = false;
    if (saved) {
      const changed =
        (saved.etag && p.etag && saved.etag !== p.etag) ||
        (saved.lastModified && p.lastModified && saved.lastModified !== p.lastModified) ||
        (saved.size !== null && p.size !== null && saved.size !== p.size);
      let partSize = -1;
      try {
        partSize = fs.statSync(this._partPath as string).size;
      } catch {
        /* missing */
      }
      if (changed) {
        this._warn('remote-changed', 'The file on the server changed since the last attempt: restarting from zero.');
      } else if (!saved.resumable || this.mode !== 'multi') {
        this._warn('not-resumable', 'The previous attempt cannot be resumed: restarting from zero.');
      } else if (partSize !== p.size || !validateSegments(saved.segments, p.size as number)) {
        this._warn('part-invalid', 'The partial file or progress record is damaged: restarting from zero.');
      } else {
        resume = true;
        this._segments = saved.segments.map((s) => ({ start: s.start, end: s.end, pos: s.pos }));
        this._downloaded = downloadedBytes(this._segments);
      }
    }

    this._fh = await fs.promises.open(this._partPath as string, resume ? 'r+' : 'w');
    if (!resume) {
      if (this._size !== null) await this._fh.truncate(this._size); // preallocate
      this._segments = this._initSegments();
      this._downloaded = 0;
    }
    this._dirty = true;
    await this._flushSidecar();
  }

  /** Throw away partial data and start over (after the server changed or ignored ranges). */
  private async _resetFresh(reprobe: boolean): Promise<void> {
    this._newCtrl();
    if (reprobe) {
      const p = await this._withRetry(() => probe(this.url, this.headers, this._ctrl.signal));
      this._applyProbe(p);
    }
    const fh = this._fh as FileHandle;
    await fh.truncate(0);
    if (this._size !== null) await fh.truncate(this._size);
    this._segments = this._initSegments();
    this._active.clear();
    this._inflight.clear();
    this._downloaded = 0;
    this._dirty = true;
    await this._flushSidecar();
  }

  // ------------------------------------------------------------------- sidecar

  private _buildSidecar(): Sidecar {
    const multi = this.mode === 'multi';
    const segments = multi
      ? this._segments.map((s) => ({ start: s.start, end: s.end, pos: s.pos - (this._inflight.get(s) ?? 0) }))
      : [];
    return {
      version: 1,
      url: this.url,
      fileName: this._baseName,
      size: this._size,
      etag: this._etag,
      lastModified: this._lastModified,
      resumable: multi,
      segments,
      downloaded: multi ? downloadedBytes(segments) : 0,
      updatedAt: new Date().toISOString(),
    };
  }

  private _flushSidecar(): Promise<void> {
    const target = this._sidecarPath;
    if (!target) return Promise.resolve();
    const json = JSON.stringify(this._buildSidecar());
    this._sidecarChain = this._sidecarChain.then(async () => {
      try {
        const tmp = target + '.tmp';
        await fs.promises.writeFile(tmp, json);
        await fs.promises.rename(tmp, target);
      } catch {
        /* progress record is best effort; the download itself continues */
      }
    });
    return this._sidecarChain;
  }

  // -------------------------------------------------------------------- timers

  private _startTimers(): void {
    this._stopTimers();
    this._tickCount = 0;
    this._lastTickAt = performance.now();
    this._lastTickBytes = this._downloaded;
    this._timer = setInterval(() => this._tick(), 250);
  }

  private _stopTimers(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  private _tick(): void {
    const now = performance.now();
    const dt = (now - this._lastTickAt) / 1000;
    if (dt > 0) {
      const inst = Math.max(0, (this._downloaded - this._lastTickBytes) / dt);
      this.speed = this.speed === 0 ? inst : this.speed * 0.7 + inst * 0.3;
      if (this.speed < 1) this.speed = 0;
    }
    this._lastTickAt = now;
    this._lastTickBytes = this._downloaded;
    this.emit('progress', this.getProgress());
    if (++this._tickCount % 4 === 0 && this._dirty) {
      this._dirty = false;
      void this._flushSidecar();
    }
  }

  // ------------------------------------------------------------------ transfer

  private _fail(e: unknown, ctrl: AbortController): void {
    if (!this._failure) {
      this._failure = toError(e);
      ctrl.abort();
    }
  }

  private async _transfer(): Promise<'complete' | 'stopped' | 'restart'> {
    const ctrl = this._newCtrl();
    this._failure = null;
    this._active.clear();
    const workers: Promise<void>[] = [];
    if (this.mode === 'multi') {
      if (this._segments.every((s) => remaining(s) === 0)) return 'complete';
      for (let i = 0; i < this.connections; i++) workers.push(this._worker(ctrl));
    } else {
      workers.push(this._singleWorker(ctrl));
    }
    await Promise.all(workers);

    const f = this._failure as Error | null; // set by workers while we awaited
    if (f) {
      if (f instanceof RangeUnsupportedError) {
        this._warn('ranges-ignored', 'Server ignored the Range header: falling back to a single connection, no resume.');
        this.mode = 'single';
        this.resumable = false;
        await this._resetFresh(false);
        return 'restart';
      }
      if (f instanceof RemoteChangedError && this._restarts < 1) {
        this._restarts++;
        this._warn('remote-changed', `${f.message}: restarting from zero.`);
        await this._resetFresh(true);
        return 'restart';
      }
      throw f;
    }
    if (this._stopReason) return 'stopped';
    if (this.mode === 'multi' && this._segments.some((s) => remaining(s) > 0)) throw new Error('Download ended with missing data');
    return 'complete';
  }

  private _claimSegment(): Segment | null {
    let seg: Segment | null = this._segments.find((s) => remaining(s) > 0 && !this._active.has(s)) ?? null;
    if (!seg) seg = stealWork(this._segments, this.stealMinSize);
    if (seg) this._active.add(seg);
    return seg;
  }

  private async _worker(ctrl: AbortController): Promise<void> {
    try {
      for (;;) {
        if (ctrl.signal.aborted) return;
        const seg = this._claimSegment();
        if (!seg) return;
        try {
          await this._runSegment(seg, ctrl);
        } finally {
          this._active.delete(seg);
        }
      }
    } catch (e) {
      this._fail(e, ctrl);
    }
  }

  /** Fetch one segment to the end, retrying transient failures with exponential backoff. */
  private async _runSegment(seg: Segment, ctrl: AbortController): Promise<void> {
    let failures = 0;
    for (;;) {
      if (ctrl.signal.aborted || remaining(seg) === 0) return;
      const before = seg.pos;
      try {
        await this._fetchRange(seg, ctrl);
        if (ctrl.signal.aborted || remaining(seg) === 0) return;
        throw new TransientError('Connection closed before the segment was complete');
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (!isTransientError(e)) throw e;
        failures = seg.pos > before ? 1 : failures + 1; // any progress resets the counter
        if (failures >= this.maxTries) throw e;
        await sleep(this._backoff(failures, e), ctrl.signal);
      }
    }
  }

  /** One ranged request for seg.pos..seg.end. */
  private async _fetchRange(seg: Segment, ctrl: AbortController): Promise<void> {
    const reqStart = seg.pos;
    const reqEnd = seg.end;
    await this._attempt(ctrl, { range: `bytes=${reqStart}-${reqEnd}` }, async (res, signal, idle) => {
      if (res.status === 200) throw new RangeUnsupportedError();
      if (res.status === 416) throw new RemoteChangedError('Server rejected the requested range');
      if (res.status !== 206) throw new HttpStatusError(res.status, this.url, parseRetryAfter(res.headers['retry-after'] as string | undefined));
      const cr = parseContentRange(res.headers['content-range'] as string | undefined);
      if (!cr || cr.start !== reqStart || cr.end !== reqEnd) {
        throw new Error('Server returned a Content-Range that does not match the request');
      }
      if (cr.total !== null && this._size !== null && cr.total !== this._size) {
        throw new RemoteChangedError('The file size on the server changed');
      }
      this._checkEtag(res.headers.etag as string | undefined);
      await this._pump(res.body, seg, signal, idle);
    });
  }

  private _checkEtag(etag: string | undefined): void {
    if (this._etag && etag && etag !== this._etag) throw new RemoteChangedError('The file changed on the server during the download');
  }

  /**
   * Shared request wrapper: per-attempt abort + stall timer. `handler` receives the response.
   * Stall means no data for idleTimeoutMs while we are waiting on the network (time spent
   * in the speed limiter or on disk does not count).
   */
  private async _attempt(
    ctrl: AbortController,
    req: { range?: string },
    handler: (res: HttpResponse, signal: AbortSignal, idle: { arm(): void; disarm(): void }) => Promise<void>,
  ): Promise<void> {
    const attempt = new AbortController();
    const signal = AbortSignal.any([ctrl.signal, attempt.signal]);
    let timer: NodeJS.Timeout | null = null;
    let stalled = false;
    const idle = {
      arm: () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          attempt.abort();
        }, this.idleTimeoutMs);
      },
      disarm: () => {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
    idle.arm();
    let res: HttpResponse | null = null;
    try {
      this.stats.requests++;
      const headers = req.range ? { ...this.headers, range: req.range } : this.headers;
      res = await httpRequest(this.url, { headers, signal });
      await handler(res, signal, idle);
    } catch (e) {
      if (stalled && !ctrl.signal.aborted) throw new TransientError(`No data received for ${Math.round(this.idleTimeoutMs / 1000)} s`);
      throw e;
    } finally {
      idle.disarm();
      res?.body.destroy();
    }
  }

  /** Copy a response body into the file at seg.pos, clipping to seg.end (which other workers may shrink). */
  private async _pump(
    body: AsyncIterable<Buffer>,
    seg: Segment,
    signal: AbortSignal,
    idle: { arm(): void; disarm(): void },
  ): Promise<void> {
    const fh = this._fh as FileHandle;
    for await (const chunk of body) {
      idle.disarm();
      this.stats.bytesFetched += chunk.length;
      if (this.limiter) await this.limiter.consume(chunk.length, signal);
      if (signal.aborted) return;
      const room = seg.end - seg.pos + 1;
      if (room <= 0) return;
      const buf = chunk.length > room ? chunk.subarray(0, room) : chunk;
      const offset = seg.pos;
      seg.pos += buf.length; // claim synchronously so work stealing sees an exact position
      this._downloaded += buf.length;
      this._inflight.set(seg, buf.length);
      try {
        let written = 0;
        while (written < buf.length) {
          const r = await fh.write(buf, written, buf.length - written, offset + written);
          written += r.bytesWritten;
        }
      } catch (e) {
        seg.pos = offset;
        this._downloaded -= buf.length;
        throw e;
      } finally {
        this._inflight.delete(seg);
      }
      this._dirty = true;
      if (seg.pos > seg.end) return;
      idle.arm();
    }
  }

  /** One plain GET of the whole file; restarts from byte 0 after any failure. */
  private async _singleWorker(ctrl: AbortController): Promise<void> {
    let failures = 0;
    try {
      for (;;) {
        if (ctrl.signal.aborted) return;
        const seg: Segment = { start: 0, end: this._size !== null ? this._size - 1 : UNKNOWN_END, pos: 0 };
        this._segments = this._size !== null ? [seg] : [];
        this._downloaded = 0;
        try {
          await this._attempt(ctrl, {}, async (res, signal, idle) => {
            if (res.status !== 200) {
              throw new HttpStatusError(res.status, this.url, parseRetryAfter(res.headers['retry-after'] as string | undefined));
            }
            this._checkEtag(res.headers.etag as string | undefined);
            const cl = res.headers['content-length'];
            if (typeof cl === 'string' && /^\d+$/.test(cl)) {
              const n = Number(cl);
              if (this._size !== n) {
                this._size = n;
                seg.end = n - 1;
                this._segments = [seg];
              }
            }
            await this._pump(res.body, seg, signal, idle);
          });
          if (ctrl.signal.aborted) return;
          if (this._size !== null && seg.pos <= seg.end) throw new TransientError('Connection closed before the file was complete');
          if (this._size === null) {
            this._size = seg.pos;
            seg.end = seg.pos - 1;
          }
          await (this._fh as FileHandle).truncate(this._size);
          return;
        } catch (e) {
          if (ctrl.signal.aborted) return;
          if (!isTransientError(e)) throw e;
          if (++failures >= this.maxTries) throw e;
          await sleep(this._backoff(failures, e), ctrl.signal);
        }
      }
    } catch (e) {
      this._fail(e, ctrl);
    }
  }

  // ------------------------------------------------------------------ finalize

  private async _finalize(): Promise<void> {
    this._setState('verifying');
    this._stopTimers();
    this.speed = 0;
    this.emit('progress', this.getProgress());
    await this._closeFile(true);
    const part = this._partPath as string;
    const size = this._size as number;
    const stat = await fs.promises.stat(part);
    if (stat.size !== size) throw new Error(`Size mismatch: expected ${size} bytes, file has ${stat.size}`);
    const signal = this._newCtrl().signal;
    const hash = await sha256File(part, signal);
    if (this.expectedSha256 && hash !== this.expectedSha256) {
      const sp = this._sidecarPath;
      this._sidecarPath = null;
      await this._sidecarChain;
      fs.rmSync(part, { force: true });
      if (sp) fs.rmSync(sp, { force: true });
      throw new Error(`SHA-256 mismatch: expected ${this.expectedSha256}, got ${hash}. The corrupt file was deleted.`);
    }
    const finalPath = await withRenameLock(async () => {
      const name = uniqueName(this.dir, this._baseName);
      const target = path.join(this.dir, name);
      await renameWithRetry(part, target);
      return target;
    });
    const sp = this._sidecarPath;
    this._sidecarPath = null;
    await this._sidecarChain;
    if (sp) fs.rmSync(sp, { force: true });
    this.path = finalPath;
    this.sha256 = hash;
    this._setState('done');
    this.emit('done', { path: finalPath, sha256: hash, size } satisfies DoneInfo);
  }
}
