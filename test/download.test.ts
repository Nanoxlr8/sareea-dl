import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Download, Limiter } from '../src/index.ts';
import type { ProgressInfo, WarningInfo } from '../src/index.ts';
import { makeBuffer, rmDir, sha256, startServer, tmpDir, waitFor } from './helpers.ts';
import type { TestServer } from './helpers.ts';

const MiB = 1024 * 1024;
const BIG = makeBuffer(20 * MiB, 7);
const BIG_SHA = sha256(BIG);
const FAST = { retryBaseDelayMs: 5 };

function readFinal(p: string | null): Buffer {
  assert.ok(p, 'download has no final path');
  return fs.readFileSync(p);
}

describe('Download', () => {
  const servers: TestServer[] = [];
  const dirs: string[] = [];
  const track = async (opts: Parameters<typeof startServer>[0]) => {
    const s = await startServer(opts);
    servers.push(s);
    return s;
  };
  const newDir = () => {
    const d = tmpDir();
    dirs.push(d);
    return d;
  };
  after(async () => {
    for (const s of servers) await s.close();
    for (const d of dirs) rmDir(d);
  });

  it('1. range server, 8 connections: output sha256 equals the source', async () => {
    const server = await track({ buffer: BIG });
    const dir = newDir();
    const d = new Download({ url: `${server.url}/file1.bin`, dir, connections: 8, ...FAST });
    let sawParallel = false;
    d.on('progress', (p: ProgressInfo) => {
      if (p.segments.length > 1) sawParallel = true;
    });
    const doneEvent = waitFor<{ path: string; sha256: string }>(d, 'done');
    assert.equal(await d.start(), 'done');
    const info = await doneEvent;
    assert.equal(d.mode, 'multi');
    assert.equal(info.sha256, BIG_SHA);
    assert.equal(path.basename(info.path), 'file1.bin');
    assert.equal(sha256(readFinal(info.path)), BIG_SHA);
    assert.deepEqual(fs.readdirSync(dir), ['file1.bin'], 'part file and sidecar are cleaned up');
    const gets = server.requests.filter((r) => r.method === 'GET');
    assert.ok(gets.length >= 8, `expected >= 8 ranged GETs, saw ${gets.length}`);
    assert.ok(gets.every((r) => r.range), 'every GET was ranged');
    assert.ok(sawParallel || gets.length >= 8);
  });

  it('1b. dynamic segmentation: idle workers steal from a slow segment, bytes still exact', async () => {
    const server = await track({ buffer: BIG, slowFirstSegment: true });
    const dir = newDir();
    const d = new Download({ url: `${server.url}/steal.bin`, dir, connections: 4, stealMinSize: 256 * 1024, ...FAST });
    let maxSegments = 0;
    d.on('progress', (p: ProgressInfo) => (maxSegments = Math.max(maxSegments, p.segments.length)));
    assert.equal(await d.start(), 'done');
    const gets = server.requests.filter((r) => r.method === 'GET');
    assert.ok(gets.length > 4, `expected extra requests from stealing, saw ${gets.length}`);
    assert.equal(sha256(readFinal(d.path)), BIG_SHA);
  });

  it('2. no-range server: single connection, correct bytes', async () => {
    const server = await track({ buffer: BIG, ranges: false });
    const dir = newDir();
    const d = new Download({ url: `${server.url}/plain.bin`, dir, connections: 8, ...FAST });
    const warnings: WarningInfo[] = [];
    d.on('warning', (w: WarningInfo) => warnings.push(w));
    assert.equal(await d.start(), 'done');
    assert.equal(d.mode, 'single');
    assert.equal(d.resumable, false);
    assert.ok(warnings.some((w) => w.code === 'single-connection'), 'tells the user resume is unavailable');
    assert.equal(sha256(readFinal(d.path)), BIG_SHA);
    const fullGets = server.requests.filter((r) => r.method === 'GET' && !r.range);
    assert.equal(fullGets.length, 1, 'exactly one full-file GET');
    assert.ok(
      server.requests.filter((r) => r.method === 'GET' && r.range).every((r) => r.range === 'bytes=0-0'),
      'only the 1-byte probe used Range',
    );
  });

  it('3. sockets killed midway: retries succeed, correct bytes', async () => {
    const server = await track({ buffer: BIG, killEvery: 3 });
    const dir = newDir();
    const d = new Download({ url: `${server.url}/flaky.bin`, dir, connections: 8, ...FAST });
    assert.equal(await d.start(), 'done');
    assert.ok(server.kills > 0, 'the server really killed some connections');
    assert.equal(sha256(readFinal(d.path)), BIG_SHA);
  });

  it('4. pause mid-download, a new Download resumes and re-fetches less than the total', async () => {
    const server = await track({ buffer: BIG });
    const dir = newDir();
    const url = `${server.url}/resume.bin`;
    const first = new Download({ url, dir, connections: 8, limiter: new Limiter(8 * MiB), ...FAST });
    const enough = waitFor<ProgressInfo>(first, 'progress', (p) => p.downloaded >= 6 * MiB);
    const run1 = first.start();
    await enough;
    await first.pause();
    assert.equal(await run1, 'paused');
    assert.equal(first.state, 'paused');
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['resume.bin.part', 'resume.bin.sareea.json'], 'part + sidecar left behind');
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'resume.bin.sareea.json'), 'utf8'));
    assert.ok(sidecar.downloaded >= 6 * MiB && sidecar.downloaded < BIG.length);
    assert.ok(!JSON.stringify(sidecar).toLowerCase().includes('cookie'));

    const second = new Download({ url, dir, connections: 8, ...FAST });
    const warnings: WarningInfo[] = [];
    second.on('warning', (w: WarningInfo) => warnings.push(w));
    assert.equal(await second.start(), 'done');
    assert.deepEqual(warnings, [], 'a clean resume warns about nothing');
    assert.ok(
      second.stats.bytesFetched <= BIG.length - sidecar.downloaded,
      `fetched ${second.stats.bytesFetched}, but only ${BIG.length - sidecar.downloaded} were missing`,
    );
    assert.ok(second.stats.bytesFetched < BIG.length);
    assert.equal(sha256(readFinal(second.path)), BIG_SHA);
    assert.deepEqual(fs.readdirSync(dir), ['resume.bin']);
  });

  it('5. ETag changes between pause and resume: restarts from zero, warns, final bytes are the new file', async () => {
    const server = await track({ buffer: BIG, etag: '"v1"' });
    const dir = newDir();
    const url = `${server.url}/changing.bin`;
    const first = new Download({ url, dir, connections: 8, limiter: new Limiter(8 * MiB), ...FAST });
    const enough = waitFor<ProgressInfo>(first, 'progress', (p) => p.downloaded >= 4 * MiB);
    const run1 = first.start();
    await enough;
    await first.pause();
    await run1;

    const NEW = makeBuffer(20 * MiB, 99);
    server.setContent(NEW, '"v2"');
    const second = new Download({ url, dir, connections: 8, ...FAST });
    const warnings: WarningInfo[] = [];
    second.on('warning', (w: WarningInfo) => warnings.push(w));
    assert.equal(await second.start(), 'done');
    assert.ok(warnings.some((w) => w.code === 'remote-changed'), `warnings: ${JSON.stringify(warnings)}`);
    assert.ok(second.stats.bytesFetched >= NEW.length, 'everything was fetched again');
    assert.equal(sha256(readFinal(second.path)), sha256(NEW));
  });

  it('6. speed limit of 2 MiB/s on a 4 MiB file takes about 2 s', async () => {
    const small = makeBuffer(4 * MiB, 3);
    const server = await track({ buffer: small });
    const dir = newDir();
    const limiter = new Limiter(2 * MiB);
    const d = new Download({ url: `${server.url}/slow.bin`, dir, connections: 4, limiter, ...FAST });
    const t0 = performance.now();
    assert.equal(await d.start(), 'done');
    const secs = (performance.now() - t0) / 1000;
    assert.ok(secs >= 1.5, `took only ${secs.toFixed(2)} s`);
    assert.ok(secs < 8, `took ${secs.toFixed(2)} s, limiter is far too slow`);
    assert.equal(sha256(readFinal(d.path)), sha256(small));
  });

  it('limiter can be changed while a download runs', async () => {
    const small = makeBuffer(6 * MiB, 4);
    const server = await track({ buffer: small });
    const dir = newDir();
    const limiter = new Limiter(512 * 1024);
    const d = new Download({ url: `${server.url}/speedup.bin`, dir, connections: 4, limiter, ...FAST });
    const t0 = performance.now();
    const started = waitFor<ProgressInfo>(d, 'progress', (p) => p.downloaded > 0);
    const run = d.start();
    await started;
    limiter.setLimit(0);
    assert.equal(await run, 'done');
    assert.ok((performance.now() - t0) / 1000 < 6, 'lifting the limit sped the download up');
    assert.equal(sha256(readFinal(d.path)), sha256(small));
  });

  it('a 200 reply to a ranged request falls back to a single connection', async () => {
    const small = makeBuffer(3 * MiB, 5);
    // Advertises ranges but ignores them (only the HEAD / probe look honest).
    const http = await import('node:http');
    const srv = http.createServer((req, res) => {
      const h = { 'Content-Length': String(small.length), 'Accept-Ranges': 'bytes', ETag: '"x"' };
      res.writeHead(200, h);
      if (req.method === 'HEAD') res.end();
      else res.end(small);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    const dir = newDir();
    const d = new Download({ url: `http://127.0.0.1:${port}/liar.bin`, dir, connections: 4, ...FAST });
    const warnings: WarningInfo[] = [];
    d.on('warning', (w: WarningInfo) => warnings.push(w));
    try {
      assert.equal(await d.start(), 'done');
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
    assert.ok(warnings.some((w) => w.code === 'ranges-ignored'));
    assert.equal(d.mode, 'single');
    assert.equal(sha256(readFinal(d.path)), sha256(small));
  });

  it('checks expectedSha256 and deletes a corrupt result', async () => {
    const small = makeBuffer(1 * MiB, 6);
    const server = await track({ buffer: small });
    const dir = newDir();
    const bad = new Download({ url: `${server.url}/sum.bin`, dir, expectedSha256: '0'.repeat(64), ...FAST });
    const errors: Error[] = [];
    bad.on('error', (e: Error) => errors.push(e));
    assert.equal(await bad.start(), 'error');
    assert.match(String(errors[0]?.message), /SHA-256 mismatch/);
    assert.deepEqual(fs.readdirSync(dir), []);

    const good = new Download({ url: `${server.url}/sum.bin`, dir, expectedSha256: sha256(small).toUpperCase(), ...FAST });
    assert.equal(await good.start(), 'done');
  });

  it('never overwrites: a second file with the same name gets "(1)"', async () => {
    const small = makeBuffer(512 * 1024, 8);
    const server = await track({ buffer: small });
    const dir = newDir();
    const a = new Download({ url: `${server.url}/same.bin`, dir, ...FAST });
    const b = new Download({ url: `${server.url}/same.bin`, dir, ...FAST });
    assert.equal(await a.start(), 'done');
    assert.equal(await b.start(), 'done');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['same (1).bin', 'same.bin']);
  });

  it('refuses non-http(s) URLs and reports HTTP errors without leaking headers', async () => {
    assert.throws(() => new Download({ url: 'file:///etc/passwd', dir: '.' }), /http/i);
    assert.throws(() => new Download({ url: 'ftp://example.com/x', dir: '.' }), /http/i);
    const server = await track({ buffer: makeBuffer(1024, 1) });
    const dir = newDir();
    const d = new Download({
      url: `${server.url}/missing`,
      dir,
      headers: { Cookie: 'session=TOPSECRET-COOKIE' },
      ...FAST,
    });
    const errors: Error[] = [];
    d.on('error', (e: Error) => errors.push(e));
    assert.equal(await d.start(), 'error');
    assert.match(String(errors[0]?.message), /404/);
    assert.ok(!String(errors[0]?.message).includes('TOPSECRET'));
    assert.ok(server.seenHeaders.get('cookie')?.includes('session=TOPSECRET-COOKIE'), 'the header was still sent');
  });

  it('cancel(true) removes the part file and sidecar', async () => {
    const server = await track({ buffer: BIG });
    const dir = newDir();
    const d = new Download({ url: `${server.url}/cancel.bin`, dir, limiter: new Limiter(4 * MiB), ...FAST });
    const enough = waitFor<ProgressInfo>(d, 'progress', (p) => p.downloaded >= 1 * MiB);
    const run = d.start();
    await enough;
    await d.cancel(true);
    assert.equal(await run, 'cancelled');
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
