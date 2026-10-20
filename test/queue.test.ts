import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Queue } from '../src/index.ts';
import { makeBuffer, rmDir, sha256, startServer, tmpDir } from './helpers.ts';
import type { TestServer } from './helpers.ts';

const MiB = 1024 * 1024;

describe('Queue', () => {
  const servers: TestServer[] = [];
  const dirs: string[] = [];
  after(async () => {
    for (const s of servers) await s.close();
    for (const d of dirs) rmDir(d);
  });
  const newDir = () => {
    const d = tmpDir();
    dirs.push(d);
    return d;
  };

  it('9a. respects maxConcurrent', async () => {
    const data = makeBuffer(4 * MiB, 11);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const dir = newDir();
    // Global limit keeps every download alive long enough for the overlap to be observable.
    const q = new Queue({ maxConcurrent: 2, limitBytesPerSec: 4 * MiB });
    const active = new Set<string>();
    let maxSeen = 0;
    const started: string[] = [];
    q.on('state', ({ id, state }: { id: string; state: string }) => {
      if (state === 'probing' || state === 'downloading' || state === 'verifying') {
        if (!active.has(id)) started.push(id);
        active.add(id);
      } else {
        active.delete(id);
      }
      maxSeen = Math.max(maxSeen, active.size);
    });
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(q.add({ url: `${server.url}/f${i}.bin`, dir, connections: 2, retryBaseDelayMs: 5 }));
    // Immediately after add(), only two may have been launched.
    assert.equal(q.list().filter((i) => i.status !== 'queued').length, 2);
    await q.whenIdle();
    assert.ok(maxSeen <= 2, `saw ${maxSeen} concurrent downloads`);
    assert.equal(maxSeen, 2, 'it did use both slots');
    assert.deepEqual(started.slice(0, 2), ids.slice(0, 2), 'FIFO order');
    const items = q.list();
    assert.ok(items.every((i) => i.status === 'done'), JSON.stringify(items.map((i) => i.status)));
    for (const i of items) assert.equal(sha256(fs.readFileSync(i.path as string)), sha256(data));
  });

  it('9b. lowering and raising maxConcurrent, pause/resume/cancel by id', async () => {
    const data = makeBuffer(6 * MiB, 12);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const dir = newDir();
    const q = new Queue({ maxConcurrent: 1, limitBytesPerSec: 3 * MiB });
    const a = q.add({ url: `${server.url}/a.bin`, dir, retryBaseDelayMs: 5 });
    const b = q.add({ url: `${server.url}/b.bin`, dir, retryBaseDelayMs: 5 });
    const c = q.add({ url: `${server.url}/c.bin`, dir, retryBaseDelayMs: 5 });
    assert.equal(q.get(b)?.status, 'queued');
    await q.pause(b); // paused while still queued
    assert.equal(q.get(b)?.status, 'paused');
    await q.cancel(c, true);
    assert.equal(q.get(c)?.status, 'cancelled');
    // pause the running one once it has really started: b is paused, c cancelled, so nothing else starts
    await new Promise<void>((resolve) => {
      q.on('progress', (p: { id: string; downloaded: number }) => {
        if (p.id === a && p.downloaded > 0) resolve();
      });
    });
    await q.pause(a);
    assert.equal(q.get(a)?.status, 'paused');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.bin.part', 'a.bin.sareea.json']);
    q.setLimit(0);
    q.resume(a);
    q.resume(b);
    await q.whenIdle();
    assert.equal(q.get(a)?.status, 'done');
    assert.equal(q.get(b)?.status, 'done');
    assert.equal(sha256(fs.readFileSync(q.get(a)?.path as string)), sha256(data));
    assert.equal(sha256(fs.readFileSync(q.get(b)?.path as string)), sha256(data));
  });

  it('9c. does not persist Cookie values (only that headers existed)', async () => {
    const server = await startServer({ buffer: makeBuffer(256 * 1024, 13) });
    servers.push(server);
    const dir = newDir();
    const file = path.join(newDir(), 'queue.json');
    const SECRET = 'sid=SUPER-SECRET-COOKIE-VALUE-12345';
    const BEARER = 'Bearer TOP-SECRET-TOKEN-98765';
    const q = new Queue({ persistPath: file, maxConcurrent: 1 });
    const id = q.add({
      url: `${server.url}/secret.bin`,
      dir,
      headers: { Cookie: SECRET, Authorization: BEARER, Referer: 'https://example.com/page' },
      retryBaseDelayMs: 5,
    });
    await q.whenIdle();
    await q.flush();
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('SUPER-SECRET'), 'cookie value leaked into the queue file');
    assert.ok(!text.includes('TOP-SECRET'), 'authorization value leaked into the queue file');
    assert.ok(!text.includes('example.com/page'), 'referer value leaked into the queue file');
    const saved = JSON.parse(text);
    assert.equal(saved.items.length, 1);
    assert.equal(saved.items[0].id, id);
    assert.equal(saved.items[0].hadHeaders, true);
    assert.deepEqual(saved.items[0].headerNames, ['Cookie', 'Authorization', 'Referer']);
    assert.equal(saved.items[0].status, 'done');
    assert.ok(!('headers' in saved.items[0]));
    // the server did receive the cookie, so the header really was used
    assert.ok(server.seenHeaders.get('cookie')?.includes(SECRET));
  });

  it('9d. a reloaded queue comes back paused and resumes (with headers re-supplied)', async () => {
    const data = makeBuffer(8 * MiB, 14);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const dir = newDir();
    const file = path.join(newDir(), 'queue.json');
    const q1 = new Queue({ persistPath: file, limitBytesPerSec: 2 * MiB });
    const id = q1.add({ url: `${server.url}/reload.bin`, dir, headers: { Cookie: 'a=b' }, retryBaseDelayMs: 5 });
    await new Promise<void>((resolve) => {
      q1.on('progress', (p: { id: string; downloaded: number }) => {
        if (p.downloaded >= 1 * MiB) resolve();
      });
    });
    await q1.pause(id);
    await q1.flush();

    const q2 = new Queue({ persistPath: file });
    const item = q2.get(id);
    assert.ok(item, 'item restored');
    assert.equal(item.status, 'paused');
    assert.equal(item.hadHeaders, true);
    assert.equal(q2.list().filter((i) => i.status === 'downloading').length, 0, 'nothing auto-starts');
    q2.resume(id, { Cookie: 'a=b' });
    await q2.whenIdle();
    assert.equal(q2.get(id)?.status, 'done');
    assert.equal(sha256(fs.readFileSync(q2.get(id)?.path as string)), sha256(data));
  });

  it('forwards events with the id', async () => {
    const server = await startServer({ buffer: makeBuffer(512 * 1024, 15) });
    servers.push(server);
    const dir = newDir();
    const q = new Queue();
    const seen = new Set<string>();
    q.on('added', () => seen.add('added'));
    q.on('state', (e: { id: string }) => e.id && seen.add('state'));
    q.on('progress', (e: { id: string }) => e.id && seen.add('progress'));
    q.on('done', (e: { id: string; path: string }) => e.id && e.path && seen.add('done'));
    q.on('error', () => seen.add('error'));
    const id = q.add({ url: `${server.url}/ev.bin`, dir, retryBaseDelayMs: 5 });
    await q.whenIdle();
    assert.equal(q.get(id)?.status, 'done');
    for (const e of ['added', 'state', 'done']) assert.ok(seen.has(e), `missing ${e}`);
    assert.ok(!seen.has('error'));
  });

  it('reports a failed download as status error', async () => {
    const server = await startServer({ buffer: makeBuffer(1024, 16) });
    servers.push(server);
    const dir = newDir();
    const q = new Queue();
    q.on('error', () => undefined);
    const id = q.add({ url: `${server.url}/missing`, dir, retryBaseDelayMs: 5 });
    await q.whenIdle();
    assert.equal(q.get(id)?.status, 'error');
    assert.match(String(q.get(id)?.error), /404/);
  });

  it('rejects non-http URLs at add()', () => {
    const q = new Queue();
    assert.throws(() => q.add({ url: 'file:///c:/secret.txt', dir: '.' }), /http/i);
  });
});
