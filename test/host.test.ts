/**
 * Tests the real native-messaging host program (host/SareeaHost.cs, compiled here with csc.exe) the way a
 * browser uses it: spawn it with the extension origin as its argument, write one framed message to stdin,
 * read one framed reply from stdout. The app side is either the real BridgeServer on a named pipe or a
 * small fake "Sareea DL.exe" (test/fixtures/FakeApp.cs) that the host has to start itself.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_ORIGIN, APP_EXE_NAME, HOST_EXE_NAME, MAX_NATIVE_MESSAGE_BYTES } from '../src/app/browser-integration.ts';
import { pipeSuffixForTestDir } from '../src/app/test-hooks.ts';
import { encodeMessage, FrameDecoder } from '../src/app/nativemsg.ts';
import { BridgeServer, pipeNameFor } from '../src/main/bridge.ts';
import { Logger } from '../src/main/logger.ts';
import { rmDir, tmpDir } from './helpers.ts';
import type { BridgeRequest } from '../src/app/protocol.ts';
import { buildHost, findCsc } from '../scripts/build-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = tmpDir('sareea-host-');
const hostDir = path.join(work, 'app');
const hostExe = path.join(hostDir, HOST_EXE_NAME);
const fakeApp = path.join(hostDir, APP_EXE_NAME);
const logger = new Logger(path.join(work, 'logs'), false);

before(() => {
  fs.mkdirSync(hostDir, { recursive: true });
  buildHost(hostExe, { testHooks: true }); // the TEST flavour: reads SAREEA_DL_TEST_DIR and SAREEA_DL_HOST_*_MS
  const r = spawnSync(findCsc(), ['/nologo', '/target:winexe', `/out:${fakeApp}`, path.join(root, 'test', 'fixtures', 'FakeApp.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
after(async () => {
  // the fake app (started by the host) exits a few seconds after its last use; wait for it before deleting
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  rmDir(work);
});

async function waitForFile(file: string, ms = 3000): Promise<string> {
  const end = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return fs.readFileSync(file, 'utf8');
}

/** A private "profile" per test: its own SAREEA_DL_TEST_DIR, hence its own pipe name. */
function profile(): { dir: string; pipe: string } {
  const dir = fs.mkdtempSync(path.join(work, 'p-'));
  const pipe = pipeNameFor(undefined, pipeSuffixForTestDir(dir));
  fs.writeFileSync(path.join(dir, 'pipe-name.txt'), pipe.replace(/^\\\\\.\\pipe\\/, ''));
  return { dir, pipe };
}

interface HostRun {
  code: number | null;
  reply: Record<string, unknown> | null;
  raw: Buffer;
  ms: number;
}

function runHost(opts: {
  dir: string;
  message?: unknown;
  raw?: Buffer;
  args?: string[];
  endStdin?: boolean;
  env?: Record<string, string>;
}): Promise<HostRun> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(hostExe, opts.args ?? [ALLOWED_ORIGIN, '--parent-window=0'], {
      env: { ...process.env, SAREEA_DL_TEST_DIR: opts.dir, SAREEA_DL_HOST_STARTUP_MS: '3000', SAREEA_DL_HOST_REPLY_MS: '3000', SAREEA_DL_HOST_READ_MS: '1500', ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', reject);
    child.on('exit', (code) => {
      const raw = Buffer.concat(chunks);
      const f = new FrameDecoder().push(raw);
      resolve({ code, reply: f.status === 'message' ? JSON.parse(f.text) : null, raw, ms: Math.round(performance.now() - t0) });
    });
    child.stdin.on('error', () => undefined);
    const bytes = opts.raw ?? encodeMessage(opts.message ?? { type: 'ping' });
    child.stdin.write(bytes);
    if (opts.endStdin) child.stdin.end(); // otherwise stdin stays open, like a browser's
  });
}

function appServer(pipe: string, onAdd?: (r: Extract<BridgeRequest, { type: 'add' }>) => Promise<{ ok: true } | { ok: false; error: string }>) {
  const added: Extract<BridgeRequest, { type: 'add' }>[] = [];
  const server = new BridgeServer({
    pipe,
    restrictAcl: false,
    log: logger,
    onAdd: async (r) => {
      added.push(r);
      return onAdd ? onAdd(r) : { ok: true };
    },
  });
  return { server, added };
}

describe('native host program', { skip: process.platform !== 'win32' }, () => {
  it('writes only the framed reply to stdout (no stray bytes before it), and exits with 0', async () => {
    const { dir, pipe } = profile();
    const { server } = appServer(pipe);
    await server.start();
    try {
      const r = await runHost({ dir });
      assert.equal(r.code, 0);
      assert.deepEqual(r.reply, { v: 1, ok: true });
      const body = JSON.stringify({ v: 1, ok: true });
      assert.equal(r.raw.length, 4 + body.length, 'exactly one frame and nothing else');
      assert.equal(r.raw.readUInt32LE(0), body.length);
    } finally {
      await server.stop();
    }
  });

  it('relays an add to the running app, with the cookie and user agent reaching it', async () => {
    const { dir, pipe } = profile();
    const { server, added } = appServer(pipe);
    await server.start();
    try {
      const r = await runHost({
        dir,
        message: { type: 'add', url: 'https://example.com/a.zip', fileName: 'ملف a.zip', referrer: 'https://example.com/', headers: { cookie: 'sid=abc; x=y', userAgent: 'UA/1' } },
      });
      assert.equal(r.code, 0);
      assert.deepEqual(r.reply, { v: 1, ok: true });
      assert.equal(added.length, 1);
      assert.equal(added[0].url, 'https://example.com/a.zip');
      assert.equal(added[0].fileName, 'ملف a.zip');
      assert.equal(added[0].referrer, 'https://example.com/');
      assert.equal(added[0].cookie, 'sid=abc; x=y');
      assert.equal(added[0].userAgent, 'UA/1');
      assert.match(String(added[0].id), /^h-\d+-[0-9a-f]+$/);
      assert.ok(!r.raw.toString('utf8').includes('sid=abc'), 'the cookie is never echoed back');
    } finally {
      await server.stop();
    }
  });

  it('a ping reports the app status and never starts the app', async () => {
    const { dir, pipe } = profile();
    const down = await runHost({ dir });
    assert.equal(down.code, 0);
    assert.deepEqual(down.reply, { v: 1, ok: false, error: 'app-not-running' });
    assert.equal(fs.existsSync(path.join(dir, 'fake-app-started.txt')), false, 'a ping must not launch the app');
    const { server } = appServer(pipe);
    await server.start();
    try {
      assert.deepEqual((await runHost({ dir })).reply, { v: 1, ok: true });
    } finally {
      await server.stop();
    }
  });

  it("passes the app's refusal on, and an invalid request is refused by the app, not forwarded blindly", async () => {
    const { dir, pipe } = profile();
    const { server, added } = appServer(pipe, async (r) => (r.url.includes('dup') ? { ok: false, error: 'duplicate' } : { ok: true }));
    await server.start();
    try {
      assert.deepEqual((await runHost({ dir, message: { type: 'add', url: 'https://example.com/dup.zip' } })).reply, { v: 1, ok: false, error: 'duplicate' });
      const bad = await runHost({ dir, message: { type: 'add', url: 'file:///C:/Windows/system32/cmd.exe' } });
      assert.deepEqual(bad.reply, { v: 1, ok: false, error: 'only http and https links are supported' });
      assert.equal(added.length, 1, 'the invalid request never reached the download code');
    } finally {
      await server.stop();
    }
  });

  it('starts the app when a download arrives and the app is not running, then delivers it exactly once', async () => {
    const { dir } = profile();
    const r = await runHost({ dir, message: { type: 'add', url: 'https://example.com/a.zip', headers: { cookie: 'k=v' } } });
    assert.equal(r.code, 0);
    assert.deepEqual(r.reply, { v: 1, ok: true });
    const started = fs.readFileSync(path.join(dir, 'fake-app-started.txt'), 'utf8').trim().split(/\r?\n/);
    assert.equal(started.length, 1, 'started once');
    const requests = fs.readFileSync(path.join(dir, 'requests.txt'), 'utf8').trim().split(/\r?\n/);
    assert.equal(requests.length, 1, 'delivered once');
    const req = JSON.parse(requests[0]);
    assert.equal(req.type, 'add');
    assert.equal(req.v, 1);
    assert.equal(req.headers.cookie, 'k=v');
  });

  it('"open" starts the app and does not need the pipe', async () => {
    const { dir } = profile();
    const r = await runHost({ dir, message: { type: 'open' } });
    assert.deepEqual(r.reply, { v: 1, ok: true });
    assert.equal((await waitForFile(path.join(dir, 'fake-app-started.txt'))).trim().split(/\r?\n/).length, 1);
  });

  it('gives up with app-not-running when the app cannot be started', async () => {
    // a host folder without the app exe next to it
    const lone = path.join(work, 'lone');
    fs.mkdirSync(lone, { recursive: true });
    const loneHost = path.join(lone, HOST_EXE_NAME);
    fs.copyFileSync(hostExe, loneHost);
    const { dir } = profile();
    const out = await new Promise<HostRun>((resolve) => {
      const child = spawn(loneHost, [ALLOWED_ORIGIN], { env: { ...process.env, SAREEA_DL_TEST_DIR: dir }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.on('exit', (code) => {
        const f = new FrameDecoder().push(Buffer.concat(chunks));
        resolve({ code, reply: f.status === 'message' ? JSON.parse(f.text) : null, raw: Buffer.concat(chunks), ms: 0 });
      });
      child.stdin.write(encodeMessage({ type: 'add', url: 'https://example.com/a.zip' }));
    });
    assert.deepEqual(out.reply, { v: 1, ok: false, error: 'app-not-running' });
  });

  it('refuses any caller except our extension, before it reads anything', async () => {
    const { dir, pipe } = profile();
    const { server, added } = appServer(pipe);
    await server.start();
    try {
      for (const args of [[], ['--native-host'], ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], [ALLOWED_ORIGIN.slice(0, -1)], [ALLOWED_ORIGIN + 'x'], [ALLOWED_ORIGIN.toUpperCase()], ['https://evil.example/']]) {
        const r = await runHost({ dir, args, message: { type: 'add', url: 'https://example.com/a.zip' } });
        assert.equal(r.code, 2, args.join(' '));
        assert.deepEqual(r.reply, { v: 1, ok: false, error: 'origin not allowed' });
      }
      assert.equal(added.length, 0);
      assert.equal(fs.existsSync(path.join(dir, 'fake-app-started.txt')), false);
    } finally {
      await server.stop();
    }
  });

  it('rejects an oversize frame, an empty one, a cut-off one, bad UTF-8 and silence', async () => {
    const { dir } = profile();
    const head = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n, 0);
      return b;
    };
    assert.deepEqual((await runHost({ dir, raw: head(MAX_NATIVE_MESSAGE_BYTES + 1) })).reply, { v: 1, ok: false, error: 'message too large' });
    assert.deepEqual((await runHost({ dir, raw: head(0xffffffff) })).reply, { v: 1, ok: false, error: 'message too large' });
    assert.deepEqual((await runHost({ dir, raw: head(0) })).reply, { v: 1, ok: false, error: 'empty message' });
    assert.deepEqual((await runHost({ dir, raw: Buffer.concat([head(50), Buffer.from('{"type"')]), endStdin: true })).reply, { v: 1, ok: false, error: 'incomplete message' });
    assert.deepEqual((await runHost({ dir, raw: Buffer.concat([head(2), Buffer.from([0xff, 0xfe])]) })).reply, { v: 1, ok: false, error: 'message is not valid UTF-8' });
    const quiet = await runHost({ dir, raw: Buffer.alloc(0), env: { SAREEA_DL_HOST_READ_MS: '300' } });
    assert.deepEqual(quiet.reply, { v: 1, ok: false, error: 'no message received' });
  });

  it('accepts a frame of exactly the limit (and the app then refuses the oversize field)', async () => {
    const { dir, pipe } = profile();
    const { server } = appServer(pipe);
    await server.start();
    try {
      const text = '{"type":"ping"}';
      const padded = text + ' '.repeat(MAX_NATIVE_MESSAGE_BYTES - text.length);
      const h = Buffer.alloc(4);
      h.writeUInt32LE(padded.length, 0);
      const r = await runHost({ dir, raw: Buffer.concat([h, Buffer.from(padded)]) });
      assert.deepEqual(r.reply, { v: 1, ok: true });
    } finally {
      await server.stop();
    }
  });

  it('rejects bad messages without echoing their contents', async () => {
    const { dir } = profile();
    const cases: Buffer[] = ['not json {"cookie":"SECRETVALUE"', '[]', '"SECRETVALUE"', '{}', '{"type":"shell","cmd":"SECRETVALUE"}', '{"type":"add","url":"https://x.com/a","id":"SECRETVALUE"}', '{"type":"add","url":"https://x.com/a","v":2}']
      .map((t) => {
        const body = Buffer.from(t);
        const h = Buffer.alloc(4);
        h.writeUInt32LE(body.length, 0);
        return Buffer.concat([h, body]);
      });
    for (const raw of cases) {
      const r = await runHost({ dir, raw });
      assert.equal(r.reply?.ok, false, raw.toString('utf8', 4));
      assert.equal(r.code, 1);
      assert.ok(typeof r.reply?.error === 'string' && String(r.reply.error).length < 80);
      assert.ok(!r.raw.toString('utf8').includes('SECRETVALUE'));
    }
  });

  it('the caller cannot choose the protocol version or request id', async () => {
    const { dir, pipe } = profile();
    const { server, added } = appServer(pipe);
    await server.start();
    try {
      const r = await runHost({ dir, message: { type: 'add', url: 'https://example.com/a.zip', id: 'mine', v: 9 } });
      assert.equal(r.reply?.ok, false);
      assert.equal(added.length, 0);
    } finally {
      await server.stop();
    }
  });

  it('times out when the app accepts the connection but never answers', async () => {
    const { dir, pipe } = profile();
    const hung = net.createServer((s) => s.on('data', () => undefined));
    await new Promise<void>((r) => hung.listen(pipe, r));
    try {
      const r = await runHost({ dir, message: { type: 'add', url: 'https://example.com/a.zip' }, env: { SAREEA_DL_HOST_REPLY_MS: '300' } });
      assert.deepEqual(r.reply, { v: 1, ok: false, error: 'app did not answer in time' });
    } finally {
      hung.close();
    }
  });

  it('does not accept a reply that belongs to another request', async () => {
    const { dir, pipe } = profile();
    const liar = net.createServer((s) => {
      s.setEncoding('utf8');
      s.on('data', () => s.write('{"v":1,"id":"someone-else","ok":true}\n'));
    });
    await new Promise<void>((r) => liar.listen(pipe, r));
    try {
      const r = await runHost({ dir, message: { type: 'add', url: 'https://example.com/a.zip' } });
      assert.deepEqual(r.reply, { v: 1, ok: false, error: 'unexpected reply from the app' });
    } finally {
      liar.close();
    }
  });

  it('starts fast when the app is running (host start-up latency)', async () => {
    const { dir, pipe } = profile();
    const { server } = appServer(pipe);
    await server.start();
    try {
      await runHost({ dir }); // warm the file cache
      const times: number[] = [];
      for (let i = 0; i < 5; i++) times.push((await runHost({ dir })).ms);
      times.sort((a, b) => a - b);
      console.log(`host round trip with the app running: median ${times[2]} ms (min ${times[0]}, max ${times[4]})`);
      assert.ok(times[2] < 1500, `median ${times[2]} ms`);
    } finally {
      await server.stop();
    }
  });
});
