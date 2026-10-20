import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Deterministic pseudo-random bytes (mulberry32), so every run serves the same data. */
export function makeBuffer(size: number, seed = 1): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let a = seed >>> 0;
  const words = Math.floor(size / 4);
  for (let i = 0; i < words; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    buf.writeUInt32LE((t ^ (t >>> 14)) >>> 0, i * 4);
  }
  for (let i = words * 4; i < size; i++) buf[i] = (i * 31 + seed) & 0xff;
  return buf;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function tmpDir(prefix = 'sareea-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export interface ServerOptions {
  buffer: Buffer;
  /** Honour Range requests and advertise them. Default true. */
  ranges?: boolean;
  etag?: string;
  /** Destroy the socket halfway through every Nth ranged GET. */
  killEvery?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Trickle the first ranged request (range starting at byte 0) out slowly, so the other workers finish first and steal from it. */
  slowFirstSegment?: boolean;
}

export interface RequestLog {
  method: string;
  url: string;
  range: string | null;
}

export interface TestServer {
  url: string;
  requests: RequestLog[];
  /** Ranged GETs that were deliberately killed. */
  kills: number;
  /** Replace what is served (and optionally its ETag). */
  setContent(buf: Buffer, etag?: string): void;
  /** Everything sent in request headers, lower-cased name -> values seen. */
  seenHeaders: Map<string, string[]>;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<TestServer> {
  let content = opts.buffer;
  let etag = opts.etag ?? '"v1"';
  const ranges = opts.ranges ?? true;
  const requests: RequestLog[] = [];
  const seenHeaders = new Map<string, string[]>();
  let rangedGets = 0;
  const state = { kills: 0 };

  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(req.headers)) {
      const arr = seenHeaders.get(k) ?? [];
      arr.push(Array.isArray(v) ? v.join(',') : String(v));
      seenHeaders.set(k, arr);
    }
    const rangeHeader = (req.headers.range as string | undefined) ?? null;
    requests.push({ method: req.method ?? '', url: req.url ?? '', range: rangeHeader });

    const base: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      ETag: etag,
      'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
      ...(opts.headers ?? {}),
    };
    if (ranges) base['Accept-Ranges'] = 'bytes';

    const total = content.length;
    if (req.url === '/missing') {
      res.writeHead(404).end();
      return;
    }

    let start = 0;
    let end = total - 1;
    let partial = false;
    if (ranges && rangeHeader) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (m) {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
        if (start >= total || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
          return;
        }
        partial = true;
      }
    }
    const len = end - start + 1;
    if (partial) {
      res.writeHead(206, { ...base, 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${end}/${total}` });
    } else {
      res.writeHead(200, { ...base, 'Content-Length': String(total) });
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const body = content.subarray(start, end + 1);
    if (opts.killEvery && partial) {
      rangedGets++;
      if (rangedGets % opts.killEvery === 0 && len > 1) {
        state.kills++;
        res.write(body.subarray(0, Math.max(1, Math.floor(len / 2))), () => res.socket?.destroy());
        return;
      }
    }
    if (opts.slowFirstSegment && partial && start === 0 && len > 512 * 1024) {
      let off = 0;
      const step = () => {
        if (res.destroyed || res.writableEnded) return;
        if (off >= body.length) {
          res.end();
          return;
        }
        res.write(body.subarray(off, off + 32 * 1024));
        off += 32 * 1024;
        setTimeout(step, 4);
      };
      step();
      return;
    }
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get kills() {
      return state.kills;
    },
    seenHeaders,
    setContent(buf: Buffer, newEtag?: string) {
      content = buf;
      if (newEtag) etag = newEtag;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** Resolve when `emitter` emits `event` and `pred` (if given) accepts the payload. */
export function waitFor<T = unknown>(
  emitter: { on(e: string, f: (x: T) => void): unknown; off(e: string, f: (x: T) => void): unknown },
  event: string,
  pred: (x: T) => boolean = () => true,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const fn = (x: T) => {
      if (pred(x)) {
        emitter.off(event, fn);
        resolve(x);
      }
    };
    emitter.on(event, fn);
  });
}
