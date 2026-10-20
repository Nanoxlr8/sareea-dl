import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  ALLOWED_ORIGIN, buildHostManifest, EXTENSION_ID, extensionIdFromPublicKey, HOST_NAME, hostManifestPath,
  pipeSuffixForTestDir, REGISTRY_KEYS, serializeHostManifest, testDirFromEnv,
} from '../src/app/browser-integration.ts';
import { installIntegration, integrationState, parseRegDefault, removeIntegration } from '../src/main/browser-integration.ts';
import type { RegRunner } from '../src/main/browser-integration.ts';
import { NATIVE_HOST_NAME } from '../src/extension/native.ts';
import { rmDir, tmpDir } from './helpers.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const EXE = 'C:\\Program Files\\Sareea DL\\Sareea DL.exe';

describe('extension identity', () => {
  it('EXTENSION_ID is the ID of the public key in extension/manifest.json', () => {
    assert.match(manifest.key, /^[A-Za-z0-9+/=]+$/);
    assert.equal(extensionIdFromPublicKey(manifest.key), EXTENSION_ID);
    assert.match(EXTENSION_ID, /^[a-p]{32}$/);
  });

  it('the private key is not in the repo and is ignored by git', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /^secrets\/$/m);
    assert.match(ignore, /^\*\.pem$/m);
    const tracked = fs.readdirSync(path.join(root, 'extension'), { recursive: true }).map(String);
    assert.ok(!tracked.some((f) => /\.(pem|key|crx)$/i.test(f)));
    assert.ok(!JSON.stringify(manifest).includes('PRIVATE'));
  });

  it('the allowed origin is exactly our extension ID with a trailing slash (the host enforces it, see test/host.test.ts)', () => {
    assert.equal(ALLOWED_ORIGIN, `chrome-extension://${EXTENSION_ID}/`);
  });

  it('the host name in the extension and in the app agree', () => {
    assert.equal(NATIVE_HOST_NAME, HOST_NAME);
    assert.equal(HOST_NAME, 'com.sareea.dl');
  });
});

describe('host manifest', () => {
  it('lists only our extension and the exe path', () => {
    const m = buildHostManifest(EXE);
    assert.deepEqual(m, {
      name: 'com.sareea.dl',
      description: 'Sareea DL browser integration',
      path: EXE,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
  });

  it('serialises to JSON that Chrome can read back (escaped backslashes, trailing newline)', () => {
    const text = serializeHostManifest(EXE);
    assert.ok(text.endsWith('\n'));
    assert.equal(JSON.parse(text).path, EXE);
    assert.match(text, /Program Files\\\\Sareea DL\\\\Sareea DL\.exe/);
  });

  it('refuses a relative host path', () => {
    assert.throws(() => buildHostManifest('Sareea DL.exe'), /absolute/);
    assert.throws(() => buildHostManifest('..\\x.exe'), /absolute/);
  });

  it('is written under the app data folder and the registry keys are per user (HKCU) for both browsers', () => {
    assert.equal(hostManifestPath('C:\\Users\\me\\AppData\\Roaming\\Sareea DL'), 'C:\\Users\\me\\AppData\\Roaming\\Sareea DL\\native-messaging\\com.sareea.dl.json');
    assert.equal(REGISTRY_KEYS.chrome, 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.sareea.dl');
    assert.equal(REGISTRY_KEYS.edge, 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.sareea.dl');
  });
});

describe('test hook', () => {
  it('only an absolute folder counts, and it gets its own pipe suffix', () => {
    assert.equal(testDirFromEnv({}), null);
    assert.equal(testDirFromEnv({ SAREEA_DL_TEST_DIR: 'relative' }), null);
    assert.equal(testDirFromEnv({ SAREEA_DL_TEST_DIR: 'C:\\temp\\x' }), 'C:\\temp\\x');
    assert.equal(pipeSuffixForTestDir(null), '');
    assert.match(pipeSuffixForTestDir('C:\\temp\\x'), /^-test-[0-9a-f]{10}$/);
    assert.notEqual(pipeSuffixForTestDir('C:\\temp\\x'), pipeSuffixForTestDir('C:\\temp\\y'));
  });
});

// ------------------------------------------------------------- registration

/** A fake reg.exe: a map from key to default value. */
function fakeReg(): { run: RegRunner; keys: Map<string, string>; calls: string[][] } {
  const keys = new Map<string, string>();
  const calls: string[][] = [];
  const run: RegRunner = async (args) => {
    calls.push(args);
    const [cmd, key] = args;
    if (cmd === 'add') {
      assert.deepEqual(args.slice(2, 6), ['/ve', '/t', 'REG_SZ', '/d']);
      assert.equal(args[args.length - 1], '/f');
      keys.set(key, args[6]);
      return { code: 0, stdout: '' };
    }
    if (cmd === 'query') {
      if (!keys.has(key)) return { code: 1, stdout: '' };
      return { code: 0, stdout: `\r\n${key}\r\n    (Default)    REG_SZ    ${keys.get(key)}\r\n\r\n` };
    }
    if (cmd === 'delete') {
      return { code: keys.delete(key) ? 0 : 1, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
  return { run, keys, calls };
}

describe('install and remove browser integration', () => {
  it('writes the manifest and both registry values, and reports installed', async () => {
    const dir = tmpDir('sareea-integ-');
    try {
      const reg = fakeReg();
      const r = await installIntegration({ exePath: EXE, dataDir: dir, run: reg.run });
      assert.deepEqual(r, { ok: true });
      const file = hostManifestPath(dir);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).path, EXE);
      assert.equal(reg.keys.get(REGISTRY_KEYS.chrome), file);
      assert.equal(reg.keys.get(REGISTRY_KEYS.edge), file);
      assert.deepEqual(await integrationState({ dataDir: dir, run: reg.run }), { chrome: 'installed', edge: 'installed' });
    } finally {
      rmDir(dir);
    }
  });

  it('can register for one browser only', async () => {
    const dir = tmpDir('sareea-integ-');
    try {
      const reg = fakeReg();
      await installIntegration({ exePath: EXE, dataDir: dir, run: reg.run, browsers: ['chrome'] });
      assert.deepEqual([...reg.keys.keys()], [REGISTRY_KEYS.chrome]);
    } finally {
      rmDir(dir);
    }
  });

  it('is off by default: state is missing when nothing was installed, and stale when it points elsewhere', async () => {
    const dir = tmpDir('sareea-integ-');
    try {
      const reg = fakeReg();
      assert.deepEqual(await integrationState({ dataDir: dir, run: reg.run }), { chrome: 'missing', edge: 'missing' });
      reg.keys.set(REGISTRY_KEYS.chrome, 'D:\\somewhere\\else.json');
      assert.deepEqual(await integrationState({ dataDir: dir, run: reg.run }), { chrome: 'stale', edge: 'missing' });
    } finally {
      rmDir(dir);
    }
  });

  it('remove deletes the keys and the manifest, and is harmless when nothing is installed', async () => {
    const dir = tmpDir('sareea-integ-');
    try {
      const reg = fakeReg();
      assert.deepEqual(await removeIntegration({ dataDir: dir, run: reg.run }), { ok: true });
      await installIntegration({ exePath: EXE, dataDir: dir, run: reg.run });
      assert.deepEqual(await removeIntegration({ dataDir: dir, run: reg.run }), { ok: true });
      assert.equal(reg.keys.size, 0);
      assert.equal(fs.existsSync(hostManifestPath(dir)), false);
      assert.equal(fs.existsSync(path.dirname(hostManifestPath(dir))), false);
    } finally {
      rmDir(dir);
    }
  });

  it('reports a failing registry write', async () => {
    const dir = tmpDir('sareea-integ-');
    try {
      const r = await installIntegration({ exePath: EXE, dataDir: dir, run: async () => ({ code: 1, stdout: '' }) });
      assert.equal(r.ok, false);
    } finally {
      rmDir(dir);
    }
  });

  it('parses reg query output, including a localized value name', () => {
    assert.equal(parseRegDefault('HKEY_CURRENT_USER\\Software\\X\r\n    (Default)    REG_SZ    C:\\a b\\c.json\r\n'), 'C:\\a b\\c.json');
    assert.equal(parseRegDefault('HKEY_CURRENT_USER\\Software\\X\r\n    <NO NAME>    REG_SZ    C:\\c.json\r\n'), 'C:\\c.json');
    assert.equal(parseRegDefault('HKEY_CURRENT_USER\\Software\\X\r\n    Other    REG_SZ    zzz\r\n'), null);
    assert.equal(parseRegDefault(''), null);
  });

  it('only runs reg.exe with its argument list (no shell metacharacters in what we pass)', async () => {
    const dir = tmpDir('sareea-integ-');
    try {
      const reg = fakeReg();
      await installIntegration({ exePath: EXE, dataDir: dir, run: reg.run });
      for (const args of reg.calls) assert.ok(['add', 'query', 'delete'].includes(args[0]));
    } finally {
      rmDir(dir);
    }
  });
});

// ------------------------------------------------------ extension audit rules

describe('extension manifest and bundle (security rules)', () => {
  it('has no content scripts, no static host access and nothing exposed to web pages', () => {
    assert.equal(manifest.manifest_version, 3);
    for (const k of ['content_scripts', 'host_permissions', 'externally_connectable', 'web_accessible_resources', 'devtools_page', 'chrome_url_overrides', 'update_url', 'incognito']) {
      assert.equal(k in manifest, false, k);
    }
  });

  it('asks for exactly the five permissions and optional http(s) host access', () => {
    assert.deepEqual([...manifest.permissions].sort(), ['contextMenus', 'cookies', 'downloads', 'nativeMessaging', 'storage']);
    assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
    assert.equal('optional_permissions' in manifest, false);
    for (const banned of ['tabs', 'activeTab', 'webRequest', 'webRequestBlocking', 'scripting', '<all_urls>', 'history', 'notifications']) {
      assert.ok(!manifest.permissions.includes(banned), banned);
    }
  });

  it('has a strict extension CSP: own scripts only, no plugins, no inline, no eval, no network', () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /connect-src 'none'/);
    assert.ok(!/unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:|\*/.test(csp), csp);
    assert.deepEqual(Object.keys(manifest.content_security_policy), ['extension_pages']);
  });

  it('every file the manifest refers to exists in the extension folder', () => {
    const dir = path.join(root, 'extension');
    const refs = [manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)] as string[];
    for (const r of refs) assert.ok(fs.existsSync(path.join(dir, r)), r);
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.equal('type' in manifest.background, false);
  });

  it('the popup page has no inline script, inline style, event attribute or remote reference', () => {
    const html = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline script');
    assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'event handler attribute');
    assert.ok(!/(src|href)\s*=\s*["'](https?:)?\/\//i.test(html), 'remote reference');
  });

  it('the bundled scripts use no eval, no network API, no tab or script injection API', async () => {
    for (const entry of ['background', 'popup']) {
      const r = await build({
        entryPoints: [path.join(root, 'src', 'extension', `${entry}.ts`)],
        bundle: true, platform: 'browser', format: 'iife', target: 'chrome110', write: false, outfile: `${entry}.js`, logLevel: 'silent',
      });
      const code = r.outputFiles[0].text;
      for (const banned of [/\beval\s*\(/, /new\s+Function\b/, /\bimportScripts\b/, /\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /sendBeacon/, /\.innerHTML\b/, /\bdocument\.write\b/,
        /chrome\.tabs\b/, /chrome\.scripting\b/, /chrome\.webRequest\b/, /chrome\.history\b/, /\bimport\s*\(/]) {
        assert.ok(!banned.test(code), `${entry}: ${banned}`);
      }
      assert.ok(code.includes('chrome.'), entry);
    }
  });

  it('no extension source logs anything', () => {
    for (const f of fs.readdirSync(path.join(root, 'src', 'extension'))) {
      const code = fs.readFileSync(path.join(root, 'src', 'extension', f), 'utf8');
      assert.ok(!/console\.\w+\s*\(/.test(code), `${f} must not log (cookies could end up in a log)`);
    }
  });
});
