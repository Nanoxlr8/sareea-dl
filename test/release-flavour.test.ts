/**
 * Build flavours: the RELEASE app and host contain no test hook; the TEST flavour does (and works).
 *
 * Builds both flavours of the app bundles (esbuild, a second or two) and of the host (csc.exe) into a temp folder and
 * searches the bytes for SAREEA_DL_TEST_DIR, SAREEA_DL_HOST_, --self-test and --screenshot-dir as UTF-8 and UTF-16.
 * Also exercises the gate itself (scripts/check-release.mjs) on synthetic packages and, when present, on the real
 * release package in out/ (stale or test-flavour packages there fail this test on purpose).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_ORIGIN } from '../src/app/browser-integration.ts';
import { encodeMessage, FrameDecoder } from '../src/app/nativemsg.ts';
import { pipeSuffixForTestDir } from '../src/app/test-hooks.ts';
import { BridgeServer, pipeNameFor } from '../src/main/bridge.ts';
import { Logger } from '../src/main/logger.ts';
import { buildApp } from '../scripts/build.mjs';
import { buildHost } from '../scripts/build-host.mjs';
import { checkReleaseApp, findHookStrings, HOOK_STRINGS, readAsar } from '../scripts/check-release.mjs';
import { rmDir, tmpDir } from './helpers.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = tmpDir('sareea-flavour-');
const rel = { app: path.join(work, 'release'), host: path.join(work, 'release-host', 'sareea-dl-host.exe') };
const tst = { app: path.join(work, 'test'), host: path.join(work, 'test-host', 'sareea-dl-host.exe') };

before(async () => {
  await buildApp({ flavour: 'release', outDir: rel.app });
  await buildApp({ flavour: 'test', outDir: tst.app });
  buildHost(rel.host);
  buildHost(tst.host, { testHooks: true });
});
after(() => rmDir(work));

const names = (buf: Buffer) => [...new Set(findHookStrings(buf).map((f: { needle: string }) => f.needle))].sort();
const bytes = (...p: string[]) => fs.readFileSync(path.join(...p));

describe('hook strings the gate looks for', () => {
  it('are the four from the audit', () => {
    assert.deepEqual([...HOOK_STRINGS], ['SAREEA_DL_TEST_DIR', 'SAREEA_DL_HOST_', '--self-test', '--screenshot-dir']);
  });
  it('are found as UTF-8 and as UTF-16LE, and nothing is found in clean data', () => {
    for (const needle of HOOK_STRINGS) {
      assert.deepEqual(findHookStrings(Buffer.concat([Buffer.alloc(7), Buffer.from(needle, 'utf8')])).map((f: { encoding: string }) => f.encoding), ['utf8'], needle);
      assert.deepEqual(findHookStrings(Buffer.concat([Buffer.alloc(7), Buffer.from(needle, 'utf16le')])).map((f: { encoding: string }) => f.encoding), ['utf16le'], needle);
    }
    assert.deepEqual(findHookStrings(Buffer.from('SAREEA_PIPE_NAME self test --self_test screenshot-dir SAREEA_DL')), []);
  });
});

describe('app bundles', () => {
  it('RELEASE: no hook string in main, preload or the renderer files, and no self-test code', () => {
    for (const f of ['main.cjs', 'preload.cjs', 'renderer/app.js', 'renderer/index.html', 'renderer/styles.css']) {
      const buf = bytes(rel.app, f);
      assert.deepEqual(names(buf), [], `${f} contains a test hook`);
    }
    const main = bytes(rel.app, 'main.cjs').toString('utf8');
    assert.ok(!/SELF-TEST|runSelfTest|readTestMode|proof\.ovh|selftest/.test(main), 'self-test code is gone from the bundle');
    assert.ok(main.includes('sareea:getState') && main.includes('registerSchemesAsPrivileged'), 'but the real app is there');
  });

  it('TEST: the hooks are present (so the flavours really differ and the scan is not blind)', () => {
    const found = names(bytes(tst.app, 'main.cjs'));
    assert.deepEqual(found, ['--screenshot-dir', '--self-test', 'SAREEA_DL_TEST_DIR']);
    assert.ok(bytes(tst.app, 'main.cjs').toString('utf8').includes('SELF-TEST'));
  });

  it('the page is loaded from app://, never from a file', () => {
    for (const dir of [rel.app, tst.app]) {
      const main = bytes(dir, 'main.cjs').toString('utf8');
      assert.ok(main.includes('loadURL(APP_INDEX_URL)'), 'window loads the app:// page');
      assert.ok(!/\.loadFile\(/.test(main), 'no loadFile');
    }
  });
});

describe('native host', () => {
  it('RELEASE: no hook string in the exe, in either encoding', () => {
    assert.deepEqual(names(fs.readFileSync(rel.host)), []);
  });
  it('TEST: the hooks are in the exe', () => {
    assert.deepEqual(names(fs.readFileSync(tst.host)), ['SAREEA_DL_HOST_', 'SAREEA_DL_TEST_DIR']);
  });

  /** Runs a host with SAREEA_DL_TEST_DIR set and counts the connections a "test app" on the test pipe receives. */
  async function connectionsTo(hostExe: string): Promise<{ connections: number; reply: Record<string, unknown> | null }> {
    const dir = fs.mkdtempSync(path.join(work, 'p-'));
    const pipe = pipeNameFor(undefined, pipeSuffixForTestDir(dir));
    let connections = 0;
    const server = new BridgeServer({ pipe, log: new Logger(path.join(work, 'logs'), false), onAdd: async () => ({ ok: true }), restrictAcl: false });
    assert.equal(await server.start(), true);
    // count raw connections to the test pipe: a ping from the host is the only thing that could ever arrive there
    (server as unknown as { server: import('node:net').Server }).server.on('connection', () => {
      connections++;
    });
    try {
      const reply = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
        const child = spawn(hostExe, [ALLOWED_ORIGIN], { env: { ...process.env, SAREEA_DL_TEST_DIR: dir }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (d: Buffer) => chunks.push(d));
        child.on('error', reject);
        child.on('exit', () => {
          const f = new FrameDecoder().push(Buffer.concat(chunks));
          resolve(f.status === 'message' ? JSON.parse(f.text) : null);
        });
        child.stdin.on('error', () => undefined);
        child.stdin.write(encodeMessage({ type: 'ping' }));
      });
      return { connections, reply };
    } finally {
      await server.stop();
    }
  }

  it('the TEST host follows SAREEA_DL_TEST_DIR to the test pipe; the RELEASE host ignores it and never connects there', async () => {
    const t = await connectionsTo(tst.host);
    assert.equal(t.connections, 1, 'test host connected to the test pipe');
    assert.equal(t.reply?.ok, true);
    const r = await connectionsTo(rel.host);
    assert.equal(r.connections, 0, 'release host must not touch a "-test-" pipe, whatever the environment says');
  });
});

// ------------------------------------------------------------------ the gate

/** Writes a minimal asar (header Pickle + data) holding `files` ({ 'dist/main.cjs': Buffer, ... }). */
function writeAsar(file: string, files: Record<string, Buffer>): void {
  const tree: Record<string, unknown> = {};
  let offset = 0;
  const parts: Buffer[] = [];
  for (const [name, data] of Object.entries(files)) {
    const segs = name.split('/');
    let node = tree;
    for (const s of segs.slice(0, -1)) node = ((node[s] ??= { files: {} }) as { files: Record<string, unknown> }).files;
    node[segs[segs.length - 1]] = { size: data.length, offset: String(offset) };
    parts.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify({ files: tree }), 'utf8');
  const padded = Math.ceil(json.length / 4) * 4;
  const payload = 4 + padded;
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(4 + payload, 4);
  head.writeUInt32LE(payload, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  fs.writeFileSync(file, Buffer.concat([head, ...parts]));
}

function fakePackage(name: string, mainExtra: Buffer, hostExtra: Buffer): string {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  const main = Buffer.concat([Buffer.from('/* sareea:getState */ '), Buffer.alloc(12_000, 0x20), mainExtra]);
  writeAsar(path.join(dir, 'resources', 'app.asar'), { 'dist/main.cjs': main, 'dist/preload.cjs': Buffer.from('x'), 'dist/renderer/index.html': Buffer.from('<html>') });
  fs.writeFileSync(path.join(dir, 'sareea-dl-host.exe'), Buffer.concat([Buffer.from('MZ'), hostExtra]));
  return dir;
}

describe('release gate (scripts/check-release.mjs)', () => {
  it('reads an asar back', () => {
    const dir = fakePackage('asar-read', Buffer.from('tail'), Buffer.alloc(0));
    const files = readAsar(path.join(dir, 'resources', 'app.asar'));
    assert.deepEqual([...files.keys()].sort(), ['dist/main.cjs', 'dist/preload.cjs', 'dist/renderer/index.html']);
    assert.equal(files.get('dist/preload.cjs')?.toString(), 'x');
    assert.ok(files.get('dist/main.cjs')?.toString().endsWith('tail'));
  });

  it('passes a clean package', () => {
    const r = checkReleaseApp(fakePackage('clean', Buffer.alloc(0), Buffer.from('nothing here')));
    assert.equal(r.ok, true);
    assert.ok(r.scanned.length >= 4);
  });

  it('fails when the main bundle in the asar has a hook (UTF-8), for each of the four strings', () => {
    for (const needle of HOOK_STRINGS) {
      const r = checkReleaseApp(fakePackage('bad-main', Buffer.from(`x("${needle}")`), Buffer.alloc(0)));
      assert.equal(r.ok, false, needle);
      assert.ok(r.findings.some((f: { where: string; needle: string; encoding: string }) => f.where === 'app.asar:dist/main.cjs' && f.needle === needle && f.encoding === 'utf8'), needle);
    }
  });

  it('fails when the host exe has a hook, UTF-16 (C# literal) or UTF-8', () => {
    for (const needle of HOOK_STRINGS) {
      for (const enc of ['utf16le', 'utf8'] as const) {
        const r = checkReleaseApp(fakePackage('bad-host', Buffer.alloc(0), Buffer.from(needle, enc)));
        assert.equal(r.ok, false, `${needle} ${enc}`);
        assert.ok(r.findings.some((f: { where: string; encoding: string }) => f.where === 'sareea-dl-host.exe' && f.encoding === enc));
      }
    }
  });

  it('refuses to pass when there is nothing to scan', () => {
    assert.throws(() => checkReleaseApp(path.join(work, 'does-not-exist')), /missing/);
    const dir = path.join(work, 'empty-main');
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
    writeAsar(path.join(dir, 'resources', 'app.asar'), { 'dist/other.js': Buffer.from('x') });
    fs.writeFileSync(path.join(dir, 'sareea-dl-host.exe'), 'MZ');
    assert.throws(() => checkReleaseApp(dir), /no usable dist\/main\.cjs/);
  });

  const realRelease = path.join(root, 'out', 'Sareea DL-win32-x64');
  it('the real release package in out/ has no hook (skipped when out/ has not been built)', { skip: !fs.existsSync(path.join(realRelease, 'resources', 'app.asar')) }, () => {
    const r = checkReleaseApp(realRelease);
    assert.deepEqual(r.findings, []);
    assert.equal(r.ok, true);
  });
});
