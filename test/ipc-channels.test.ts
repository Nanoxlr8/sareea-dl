/**
 * IPC surface audit: every method the preload script exposes maps to exactly one handler, every channel name is
 * a string literal at both ends, and every handler calls the sender check first and has its own validator.
 *
 *  - preload.ts is bundled with esbuild and RUN against a fake `electron` module, so the channel of each exposed
 *    method is observed, not guessed from the text;
 *  - main.ts is read as text (it needs a real Electron to run) and checked block by block; the built release
 *    bundle is checked as well, to see that bundling kept every channel a literal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('src', 'main', 'main.ts');
const preloadSrc = read('src', 'main', 'preload.ts');
const apiSrc = read('src', 'app', 'api.ts');

const CHANNEL = /^sareea:[A-Za-z]+(?::[A-Za-z]+)?$/;

/** Method names declared in `interface SareeaApi` (the contract the page sees). */
function declaredApiMethods(): string[] {
  const body = /export interface SareeaApi \{\n([\s\S]*?)\n\}/.exec(apiSrc)?.[1] ?? '';
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
}

interface Observed {
  invokes: Map<string, string[]>; // method -> channels it invoked
  listens: Map<string, string[]>; // method -> channels it subscribed to
  unsubscribes: Map<string, string[]>; // method -> channels removed by the returned function
  exposed: Record<string, (...a: unknown[]) => unknown>;
  exposedName: string;
  frozen: boolean;
}

/** Bundle the real preload.ts and run it with a recording stand-in for electron. */
async function observePreload(): Promise<Observed> {
  const out = await build({
    entryPoints: [path.join(root, 'src', 'main', 'preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    write: false,
    logLevel: 'silent',
    define: { __SAREEA_TEST_HOOKS__: 'false' },
  });
  const code = out.outputFiles[0].text;
  let current = '';
  const invokes = new Map<string, string[]>();
  const listens = new Map<string, string[]>();
  const unsubscribes = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, ch: string) => m.set(current, [...(m.get(current) ?? []), ch]);
  const ipcRenderer = {
    invoke: (ch: string) => {
      push(invokes, ch);
      return Promise.resolve({ ok: true });
    },
    on: (ch: string) => push(listens, ch),
    removeListener: (ch: string) => push(unsubscribes, ch),
  };
  let exposed: Record<string, (...a: unknown[]) => unknown> = {};
  let exposedName = '';
  const contextBridge = {
    exposeInMainWorld: (name: string, api: Record<string, (...a: unknown[]) => unknown>) => {
      exposedName = name;
      exposed = api;
    },
  };
  const fakeRequire = (id: string) => {
    assert.equal(id, 'electron', 'the preload may require nothing but electron');
    return { contextBridge, ipcRenderer };
  };
  vm.runInNewContext(`(function (require, module, exports) {${code}\n})`, {})(fakeRequire, { exports: {} }, {});
  for (const [name, fn] of Object.entries(exposed)) {
    current = name;
    const r = name.startsWith('on') ? fn(() => undefined) : fn('x');
    if (name.startsWith('on')) (r as () => void)();
  }
  return { invokes, listens, unsubscribes, exposed, exposedName, frozen: Object.isFrozen(exposed) };
}

/** The text of every `ipcMain.handle('channel', ...)` block in a source or bundle, keyed by channel. */
function handlerBlocks(src: string, quote: "'" | '"'): { channel: string; text: string }[] {
  const re = new RegExp(`ipcMain\\.handle\\(${quote}([^${quote}]+)${quote}`, 'g');
  const starts = [...src.matchAll(re)].map((m) => ({ channel: m[1], at: m.index as number }));
  return starts.map((s, i) => ({ channel: s.channel, text: src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length) }));
}

describe('preload: what the page can call', async () => {
  const seen = await observePreload();
  const methods = Object.keys(seen.exposed);
  const invokeMethods = methods.filter((m) => !m.startsWith('on'));
  const eventMethods = methods.filter((m) => m.startsWith('on'));

  it('exposes exactly the methods declared in SareeaApi, as one frozen object named sareea', () => {
    assert.equal(seen.exposedName, 'sareea');
    assert.equal(seen.frozen, true);
    const declared = declaredApiMethods();
    assert.ok(declared.length >= 20, `parsed ${declared.length} methods from api.ts`);
    assert.deepEqual([...methods].sort(), [...declared].sort());
    assert.equal(invokeMethods.length, 21);
    assert.equal(eventMethods.length, 5);
  });

  it('every request method invokes exactly one channel, and no two methods share one', () => {
    const used = new Set<string>();
    for (const m of invokeMethods) {
      const ch = seen.invokes.get(m) ?? [];
      assert.equal(ch.length, 1, `${m} invoked ${JSON.stringify(ch)}`);
      assert.match(ch[0], CHANNEL, m);
      assert.ok(!used.has(ch[0]), `channel ${ch[0]} is used by two methods`);
      used.add(ch[0]);
      assert.equal(ch[0], `sareea:${m}`, `the channel of ${m} is named after it`);
      assert.equal(seen.listens.get(m), undefined, `${m} must not also listen`);
    }
  });

  it('every event method listens on exactly one channel and its unsubscribe removes that same channel', () => {
    const used = new Set<string>();
    for (const m of eventMethods) {
      const on = seen.listens.get(m) ?? [];
      assert.equal(on.length, 1, `${m} listened on ${JSON.stringify(on)}`);
      assert.match(on[0], /^sareea:ev:[A-Za-z]+$/);
      assert.ok(!used.has(on[0]));
      used.add(on[0]);
      assert.deepEqual(seen.unsubscribes.get(m), on, `${m} unsubscribes from the channel it subscribed to`);
      assert.equal(seen.invokes.get(m), undefined, `${m} must not also invoke`);
    }
  });

  it('the preload source uses only literal channel names (no map, no variable, no template)', () => {
    const code = preloadSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const calls = [...code.matchAll(/ipcRenderer\.(invoke|on|removeListener|send|sendSync|once|postMessage)\(\s*(.{0,60})/g)];
    assert.ok(calls.length >= 31, `found ${calls.length} ipcRenderer calls`);
    for (const c of calls) {
      assert.ok(['invoke', 'on', 'removeListener'].includes(c[1]), `ipcRenderer.${c[1]} is not allowed in the preload`);
      assert.match(c[2], /^'sareea:[A-Za-z:]+'/, `non-literal channel in: ${c[0]}`);
    }
    assert.ok(!/\bCH\b|\[\s*channel|\$\{/.test(code.replace(/`[^`]*`/g, '')), 'no channel table or computed channel');
  });

  describe('main: one literal handler per request method, each checking the sender first', () => {
    const blocks = handlerBlocks(mainSrc, "'");
    const channels = blocks.map((b) => b.channel);

    it('every ipcMain.handle call has a literal channel, and there are no other IPC entry points', () => {
      const all = [...mainSrc.matchAll(/ipcMain\.\w+\(/g)].map((m) => m[0]);
      assert.equal(all.length, blocks.length, 'every ipcMain call is a handle with a literal channel');
      assert.ok(all.every((x) => x === 'ipcMain.handle('));
      assert.equal(new Set(channels).size, channels.length, 'no channel is handled twice');
      for (const c of channels) assert.match(c, CHANNEL);
      assert.ok(!/ipcMain\.handle\(\s*[^'\s]/.test(mainSrc), 'no handle() with a computed channel');
    });

    it('the handled channels are exactly the channels the preload invokes (one-to-one)', () => {
      const invoked = invokeMethods.map((m) => (seen.invokes.get(m) ?? [])[0]);
      assert.deepEqual([...channels].sort(), [...invoked].sort());
    });

    it('each handler calls the sender check first, then its own validator, and names only its own channel', () => {
      for (const b of blocks) {
        const ch = b.channel;
        const esc = ch.replace(/[:]/g, '\\:');
        const body = b.text.slice(b.text.indexOf('{') + 1); // the arrow function's block
        const first = body.split('\n').map((l) => l.trim()).filter(Boolean);
        assert.match(first[0], new RegExp(`^const denied = rejectUntrusted\\(event, '${esc}'\\);$`), `${ch}: sender check is the first statement`);
        assert.equal(first[1], 'if (denied) return denied;', `${ch}: refuses at once`);
        assert.match(first[2], /^const v = (noArgs|validate[A-Za-z]+)\(raw\);$/, `${ch}: its own validator runs next`);
        assert.match(first[3], new RegExp(`^if \\(!v\\.ok\\) return rejectInvalid\\('${esc}', v\\.error\\);$`), `${ch}: invalid input is refused`);
        assert.match(first[4], new RegExp(`^return perform\\('${esc}', `), `${ch}: the action only runs after both checks`);
        const literals = new Set([...b.text.matchAll(/'(sareea:[A-Za-z:]+)'/g)].map((m) => m[1]));
        assert.deepEqual([...literals], [ch], `${ch}: the block names no other channel`);
        assert.equal((b.text.match(/rejectUntrusted\(/g) ?? []).length, 1);
      }
    });

    it('the sender check really is isTrustedSender against the app:// page', () => {
      assert.match(mainSrc, /function rejectUntrusted\(event: IpcMainInvokeEvent, channel: string\): Result \| null \{\n {2}if \(trusted\(event\)\) return null;/);
      assert.match(mainSrc, /function trusted\(event: IpcMainInvokeEvent\): boolean \{[\s\S]*?return isTrustedSender\(frame\.url, APP_INDEX_URL\);/);
      assert.match(mainSrc, /event\.sender !== win\.webContents/);
      assert.match(mainSrc, /frame !== event\.sender\.mainFrame/);
    });

    it('events main sends to the window use the same literal channels the preload listens on', () => {
      const sends = [...mainSrc.matchAll(/\.send\(\s*(.{0,20})/g)].map((m) => m[1]);
      assert.equal(sends.length, 5);
      for (const s of sends) assert.match(s, /^'sareea:ev:[A-Za-z]+'/);
      const sent = new Set(sends.map((s) => /'(sareea:ev:[A-Za-z]+)'/.exec(s)?.[1]));
      const listened = new Set(eventMethods.map((m) => (seen.listens.get(m) ?? [])[0]));
      assert.deepEqual([...sent].sort(), [...listened].sort());
    });
  });

  it('the bundled release main process keeps all 21 handlers as literal channels', async () => {
    const out = await build({
      entryPoints: [path.join(root, 'src', 'main', 'main.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      write: false,
      logLevel: 'silent',
      loader: { '.png': 'binary' },
      define: { __SAREEA_TEST_HOOKS__: 'false' },
      minifySyntax: true,
    });
    const code = out.outputFiles[0].text;
    const handles = [...code.matchAll(/ipcMain\.handle\(/g)].length;
    const literal = handlerBlocks(code, '"');
    assert.equal(handles, 21);
    assert.equal(literal.length, 21, 'every handle() in the bundle has a literal channel');
    assert.deepEqual(
      literal.map((b) => b.channel).sort(),
      invokeMethods.map((m) => (seen.invokes.get(m) ?? [])[0]).sort(),
    );
  });
});
