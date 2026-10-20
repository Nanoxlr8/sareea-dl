import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeBuffer, rmDir, sha256, startServer, tmpDir, waitFor } from './helpers.ts';
import type { TestServer } from './helpers.ts';
import { AppController } from '../src/main/controller.ts';
import type { Platform } from '../src/main/controller.ts';
import { Logger } from '../src/main/logger.ts';
import type { AddRequest, ViewItem } from '../src/app/api.ts';
import type { Settings } from '../src/app/settings.ts';
import { MiB } from '../src/segments.ts';

const servers: TestServer[] = [];
const dirs: string[] = [];
const controllers: AppController[] = [];

function newDir(): string {
  const d = tmpDir('sareea-ctl-');
  dirs.push(d);
  return d;
}

interface Calls {
  opened: string[];
  shown: string[];
  clipboard: string[];
  risky: string[];
}

function mk(dataDir: string, override: Partial<Settings> = {}, confirm = true): { c: AppController; calls: Calls; log: Logger } {
  const calls: Calls = { opened: [], shown: [], clipboard: [], risky: [] };
  const platform: Platform = {
    openPath: async (p) => {
      calls.opened.push(p);
      return '';
    },
    showItemInFolder: (p) => calls.shown.push(p),
    writeClipboard: (t) => calls.clipboard.push(t),
    confirmRisky: async (n) => {
      calls.risky.push(n);
      return confirm;
    },
  };
  const log = new Logger(path.join(dataDir, 'logs'), false);
  const c = new AppController({ dataDir, userProfile: 'C:\\Users\\Tester', platform, log, settingsOverride: override });
  controllers.push(c);
  return { c, calls, log };
}

const req = (url: string, extra: Partial<AddRequest> = {}): AddRequest => ({ url, fileName: null, dir: null, connections: 4, start: true, bridgeToken: null, ...extra });

after(async () => {
  for (const c of controllers) await c.shutdown().catch(() => undefined);
  for (const s of servers) await s.close();
  for (const d of dirs) rmDir(d);
});

describe('AppController', () => {
  it('adds a download into its category subfolder and reports it as completed', async () => {
    const data = makeBuffer(600 * 1024, 31);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl') });
    const done = waitFor<ViewItem>(c, 'completed');
    const r = c.addDownload(req(`${server.url}/pack.zip?token=SECRET-QUERY`));
    assert.ok(r.ok);
    const item = await done;
    assert.equal(item.status, 'done');
    assert.equal(item.category, 'compressed');
    assert.equal(path.dirname(item.path as string), path.join(root, 'dl', 'Compressed'));
    assert.equal(sha256(fs.readFileSync(item.path as string)), sha256(data));
    assert.equal(item.name, 'pack.zip');
    // Mark of the Web: Windows treats the file as coming from the internet; the query string is not stored
    await new Promise((res) => setTimeout(res, 300));
    const zone = fs.readFileSync(`${item.path}:Zone.Identifier`, 'utf8');
    assert.match(zone, /^\[ZoneTransfer\]\r\nZoneId=3\r\n/);
    assert.ok(zone.includes(`HostUrl=${server.url}/pack.zip`));
    assert.ok(!zone.includes('SECRET-QUERY'));
  });

  it('uses the plain default folder when subfolders are off, and unknown types go to General when on', async () => {
    const server = await startServer({ buffer: makeBuffer(100 * 1024, 32) });
    servers.push(server);
    const root = newDir();
    const off = mk(path.join(root, 'd1'), { defaultDir: path.join(root, 'dl1'), categorySubfolders: false });
    const a = off.c.resolveDir(null, 'x.mp4', 'https://a.com/x.mp4');
    assert.ok(a.ok);
    assert.equal(a.dir, path.join(root, 'dl1'));
    const on = mk(path.join(root, 'd2'), { defaultDir: path.join(root, 'dl2') });
    const b = on.c.resolveDir(null, null, 'https://a.com/10Mb.dat');
    assert.ok(b.ok);
    assert.equal(b.dir, path.join(root, 'dl2', 'General'));
    const v = on.c.resolveDir(null, 'clip.mkv', 'https://a.com/x');
    assert.ok(v.ok);
    assert.equal(v.dir, path.join(root, 'dl2', 'Video'));
  });

  it('"add to queue" keeps the item paused and held until Start queue', async () => {
    const server = await startServer({ buffer: makeBuffer(300 * 1024, 33) });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl') });
    const r = c.addDownload(req(`${server.url}/later.bin`, { start: false }));
    assert.ok(r.ok);
    await new Promise((res) => setTimeout(res, 300));
    const v = c.getView(r.id) as ViewItem;
    assert.equal(v.status, 'paused');
    assert.equal(v.held, true);
    assert.equal(server.requests.length, 0, 'nothing was requested');
    const done = waitFor<ViewItem>(c, 'completed');
    c.startQueue();
    const fin = await done;
    assert.equal(fin.status, 'done');
    assert.equal(fin.held, false);
  });

  it('refuses duplicates of a running link, folders the user never picked, and accepts picked ones', async () => {
    const server = await startServer({ buffer: makeBuffer(2 * MiB, 34) });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl'), speedLimitKiBps: 256 });
    const first = c.addDownload(req(`${server.url}/dup.bin`));
    assert.ok(first.ok);
    const second = c.addDownload(req(`${server.url}/dup.bin`));
    assert.ok(!second.ok);
    assert.equal(second.error, 'duplicate');

    const evil = c.addDownload(req(`${server.url}/other.bin`, { dir: 'C:\\Windows\\System32' }));
    assert.ok(!evil.ok);
    const picked = path.join(root, 'picked');
    assert.ok(!c.addDownload(req(`${server.url}/p.bin`, { dir: picked })).ok);
    c.registerPickedDir(picked);
    const okPicked = c.addDownload(req(`${server.url}/p.bin`, { dir: picked, start: false }));
    assert.ok(okPicked.ok);
    assert.equal(c.getView(okPicked.id)?.dir, path.win32.normalize(picked));
    await c.remove({ ids: [first.id, okPicked.id], deleteFile: true });
  });

  it('only accepts a new default folder that came from the folder dialog', () => {
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl') });
    const target = path.join(root, 'chosen');
    assert.ok(!c.setSettings({ defaultDir: target }).ok);
    c.registerPickedDir(target);
    const r = c.setSettings({ defaultDir: target, maxConcurrent: 2, speedLimitKiBps: 100 });
    assert.ok(r.ok);
    assert.equal(c.settings.defaultDir, target);
    assert.equal(c.queue.maxConcurrent, 2);
    assert.equal(c.queue.limiter.limit, 100 * 1024);
  });

  it('remove: finished file stays unless "delete with file"', async () => {
    const server = await startServer({ buffer: makeBuffer(200 * 1024, 35) });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl') });
    const finish = async (name: string) => {
      const done = waitFor<ViewItem>(c, 'completed', (v) => v.name === name);
      const r = c.addDownload(req(`${server.url}/${name}`));
      assert.ok(r.ok);
      return done;
    };
    const keep = await finish('keep.pdf');
    const gone = await finish('gone.pdf');
    await c.remove({ ids: [keep.id], deleteFile: false });
    assert.equal(c.getView(keep.id), null);
    assert.ok(fs.existsSync(keep.path as string), 'file kept');
    await c.remove({ ids: [gone.id], deleteFile: true });
    assert.equal(c.getView(gone.id), null);
    assert.ok(!fs.existsSync(gone.path as string), 'file deleted');
  });

  it('remove of an unfinished download deletes its partial data', async () => {
    const server = await startServer({ buffer: makeBuffer(3 * MiB, 36) });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl'), speedLimitKiBps: 512 });
    const r = c.addDownload(req(`${server.url}/half.bin`));
    assert.ok(r.ok);
    await waitFor(c.queue, 'progress', (p: { downloaded: number }) => p.downloaded > 256 * 1024);
    await c.remove({ ids: [r.id], deleteFile: false });
    const left = fs.existsSync(path.join(root, 'dl', 'General')) ? fs.readdirSync(path.join(root, 'dl', 'General')) : [];
    assert.deepEqual(left, []);
  });

  it('Open: never runs a program without confirmation, opens documents directly, refuses unfinished items', async () => {
    const server = await startServer({ buffer: makeBuffer(100 * 1024, 37) });
    servers.push(server);
    const root = newDir();
    const deny = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl') }, false);
    const finish = async (name: string) => {
      const done = waitFor<ViewItem>(deny.c, 'completed', (v) => v.name === name);
      assert.ok(deny.c.addDownload(req(`${server.url}/${name}`)).ok);
      return done;
    };
    const exe = await finish('setup.exe');
    const pdf = await finish('doc.pdf');
    const r1 = await deny.c.openFile(exe.id);
    assert.ok(!r1.ok);
    assert.equal(r1.error, 'cancelled');
    assert.deepEqual(deny.calls.risky, ['setup.exe']);
    assert.deepEqual(deny.calls.opened, [], 'the program was not started');
    const r2 = await deny.c.openFile(pdf.id);
    assert.ok(r2.ok);
    assert.deepEqual(deny.calls.opened, [pdf.path]);
    assert.deepEqual(deny.calls.risky, ['setup.exe'], 'no prompt for a pdf');
    // not an id we own
    assert.ok(!(await deny.c.openFile('00000000-0000-0000-0000-000000000000')).ok);
    // file removed from disk behind our back
    fs.unlinkSync(pdf.path as string);
    const r3 = await deny.c.openFile(pdf.id);
    assert.ok(!r3.ok);
    assert.equal(r3.error, 'file-missing');
    // folder + copy link
    const r4 = await deny.c.openFolder(exe.id);
    assert.ok(r4.ok);
    assert.deepEqual(deny.calls.shown, [exe.path]);
    assert.ok(deny.c.copyLink(exe.id).ok);
    assert.deepEqual(deny.calls.clipboard, [`${server.url}/setup.exe`]);

    const allow = mk(path.join(root, 'data2'), { defaultDir: path.join(root, 'dl2') }, true);
    const done = waitFor<ViewItem>(allow.c, 'completed');
    assert.ok(allow.c.addDownload(req(`${server.url}/ok.msi`)).ok);
    const msi = await done;
    assert.ok((await allow.c.openFile(msi.id)).ok);
    assert.deepEqual(allow.calls.opened, [msi.path]);
  });

  it('interrupted downloads come back paused after a restart and resume to a correct file', async () => {
    const data = makeBuffer(4 * MiB, 38);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const root = newDir();
    const dataDir = path.join(root, 'data');
    const first = mk(dataDir, { defaultDir: path.join(root, 'dl'), speedLimitKiBps: 1024 });
    const r = first.c.addDownload(req(`${server.url}/big.zip`));
    assert.ok(r.ok);
    await waitFor(first.c.queue, 'progress', (p: { downloaded: number }) => p.downloaded >= 1 * MiB);
    await first.c.shutdown(); // what "Quit" does

    const second = mk(dataDir, { defaultDir: path.join(root, 'dl') });
    const v = second.c.getView(r.id) as ViewItem;
    assert.ok(v, 'the item is still in the list');
    assert.equal(v.status, 'paused');
    assert.ok(v.downloaded >= 1 * MiB - 512 * 1024, 'progress was remembered');
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(second.c.getView(r.id)?.status, 'paused', 'nothing starts by itself');
    const done = waitFor<ViewItem>(second.c, 'completed');
    second.c.resume([r.id]);
    const fin = await done;
    assert.equal(sha256(fs.readFileSync(fin.path as string)), sha256(data));
    // the second run only fetched what was missing
    const fetched = second.c.queue.get(r.id)?.size ?? 0;
    assert.equal(fetched, data.length);
  });

  it('bridge: cookie is held in memory for one download, used, and never written anywhere', async () => {
    const data = makeBuffer(200 * 1024, 39);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const root = newDir();
    const dataDir = path.join(root, 'data');
    const { c, log } = mk(dataDir, { defaultDir: path.join(root, 'dl'), browserAutoStart: false });
    const prefills: { bridgeToken: string | null; hasCookie: boolean; url: string }[] = [];
    c.on('prefill', (p) => prefills.push(p));
    const SECRET = 'sessionid=SECRET-COOKIE-VALUE-123';
    const r = await c.handleBridgeAdd({
      type: 'add', id: 'x', url: `${server.url}/secure.zip`, fileName: null, referrer: `${server.url}/page`, pageUrl: null, cookie: SECRET, userAgent: 'TestBrowser/1',
    });
    assert.ok(r.ok);
    assert.equal(prefills.length, 1, 'the user is asked first');
    assert.equal(c.queue.list().length, 0, 'nothing added without confirmation');
    assert.equal(prefills[0].hasCookie, true);
    assert.ok(!JSON.stringify(prefills[0]).includes('SECRET-COOKIE'), 'the cookie value never reaches the UI');
    const token = prefills[0].bridgeToken as string;
    // the dialog's probe uses the headers too
    const probed = await c.probeUrl({ url: `${server.url}/secure.zip`, bridgeToken: token });
    assert.ok(probed.ok);
    const done = waitFor<ViewItem>(c, 'completed');
    assert.ok(c.addDownload(req(`${server.url}/secure.zip`, { bridgeToken: token })).ok);
    await done;
    assert.ok(server.seenHeaders.get('cookie')?.includes(SECRET), 'the server received the cookie');
    assert.ok(server.seenHeaders.get('user-agent')?.includes('TestBrowser/1'));
    assert.ok(server.seenHeaders.get('referer')?.some((x) => x.endsWith('/page')));
    // the token is single-use
    const again = c.addDownload(req(`${server.url}/secure2.zip`, { bridgeToken: token }));
    assert.ok(again.ok);
    await c.remove({ ids: [again.id], deleteFile: true });
    await c.shutdown();
    await log.flush();
    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (!p.startsWith(path.join(root, 'dl'))) all.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(dataDir);
    assert.ok(all.length >= 3, 'queue, settings and a log were written');
    for (const text of all) {
      assert.ok(!text.includes('SECRET-COOKIE'), 'cookie leaked to disk');
      assert.ok(!text.includes('TestBrowser'), 'user agent leaked to disk');
    }
    const queueFile = all.find((t) => t.includes('"items"')) ?? '';
    assert.ok(queueFile.includes('"hadHeaders": true'));
  });

  it('bridge with "start without asking" adds the download straight away', async () => {
    const server = await startServer({ buffer: makeBuffer(150 * 1024, 40) });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl'), browserAutoStart: true });
    const prefills: unknown[] = [];
    c.on('prefill', (p) => prefills.push(p));
    const done = waitFor<ViewItem>(c, 'completed');
    const r = await c.handleBridgeAdd({ type: 'add', id: 'y', url: `${server.url}/auto.mp4`, fileName: null, referrer: null, pageUrl: null, cookie: null, userAgent: null });
    assert.ok(r.ok);
    const fin = await done;
    assert.equal(prefills.length, 0, 'no dialog');
    assert.equal(path.basename(path.dirname(fin.path as string)), 'Video');
  });

  it('pause, stop queue and resume work on running downloads and finish with the right bytes', async () => {
    const data = makeBuffer(3 * MiB, 42);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl'), speedLimitKiBps: 1024 });
    const r = c.addDownload(req(`${server.url}/pausable.zip`));
    assert.ok(r.ok);
    await waitFor(c.queue, 'progress', (p: { downloaded: number }) => p.downloaded > 300 * 1024);
    await c.pause([r.id]);
    assert.equal(c.getView(r.id)?.status, 'paused');
    assert.equal(c.getView(r.id)?.held, false, 'a paused download is not "queued"');
    const frozen = c.getView(r.id)?.downloaded ?? 0;
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(c.getView(r.id)?.downloaded, frozen, 'no progress while paused');
    c.resume([r.id]);
    await waitFor(c.queue, 'progress', (p: { downloaded: number }) => p.downloaded > frozen + 200 * 1024);
    await c.stopQueue();
    assert.equal(c.getView(r.id)?.status, 'paused');
    const done = waitFor<ViewItem>(c, 'completed');
    c.setSettings({ speedLimitKiBps: 0 });
    c.startQueue();
    const fin = await done;
    assert.equal(sha256(fs.readFileSync(fin.path as string)), sha256(data));
  });

  it('redownload replaces the entry with a fresh download of the same link', async () => {
    const data = makeBuffer(200 * 1024, 43);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl') });
    const first = waitFor<ViewItem>(c, 'completed');
    assert.ok(c.addDownload(req(`${server.url}/again.pdf`)).ok);
    const a = await first;
    const second = waitFor<ViewItem>(c, 'completed', (v) => v.id !== a.id);
    await c.redownload([a.id]);
    const b = await second;
    assert.equal(c.getView(a.id), null, 'the old entry is gone');
    assert.equal(b.url, a.url);
    assert.equal(b.status, 'done');
    assert.equal(sha256(fs.readFileSync(b.path as string)), sha256(data));
    assert.equal(c.queue.list().length, 1);
  });

  it('the batch event carries upserts and removals', async () => {
    const server = await startServer({ buffer: makeBuffer(100 * 1024, 41) });
    servers.push(server);
    const root = newDir();
    const { c } = mk(path.join(root, 'data'), { defaultDir: path.join(root, 'dl') });
    const seen = new Map<string, ViewItem>();
    const removed: string[] = [];
    c.on('batch', (b: { upserts: ViewItem[]; removed: string[] }) => {
      for (const u of b.upserts) seen.set(u.id, u);
      removed.push(...b.removed);
    });
    const done = waitFor<ViewItem>(c, 'completed');
    const r = c.addDownload(req(`${server.url}/b.txt`));
    assert.ok(r.ok);
    await done;
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(seen.get(r.id)?.status, 'done');
    await c.remove({ ids: [r.id], deleteFile: true });
    await new Promise((res) => setTimeout(res, 400));
    assert.deepEqual(removed, [r.id]);
  });
});
