import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { APP_HOST, APP_INDEX_URL, APP_ORIGIN, APP_SCHEME, resolveAppRequest } from '../src/app/app-scheme.ts';

const ROOT = 'C:\\Program Files\\Sareea DL\\resources\\app.asar\\dist\\renderer';
const at = (...p: string[]) => path.join(ROOT, ...p);

describe('app:// scheme constants', () => {
  it('the page is app://sareea/index.html', () => {
    assert.equal(APP_SCHEME, 'app');
    assert.equal(APP_HOST, 'sareea');
    assert.equal(APP_ORIGIN, 'app://sareea');
    assert.equal(APP_INDEX_URL, 'app://sareea/index.html');
  });
});

describe('resolveAppRequest: what is served', () => {
  it('maps the three renderer files, and / to index.html', () => {
    assert.deepEqual(resolveAppRequest('app://sareea/index.html', ROOT), { file: at('index.html'), mime: 'text/html; charset=utf-8' });
    assert.deepEqual(resolveAppRequest('app://sareea/app.js', ROOT), { file: at('app.js'), mime: 'text/javascript; charset=utf-8' });
    assert.deepEqual(resolveAppRequest('app://sareea/styles.css', ROOT), { file: at('styles.css'), mime: 'text/css; charset=utf-8' });
    assert.deepEqual(resolveAppRequest('app://sareea/', ROOT), { file: at('index.html'), mime: 'text/html; charset=utf-8' });
    assert.deepEqual(resolveAppRequest('app://sareea', ROOT), { file: at('index.html'), mime: 'text/html; charset=utf-8' });
  });
  it('ignores query and hash, and is case-insensitive for scheme and host only', () => {
    assert.equal(resolveAppRequest('app://sareea/app.js?v=1#x', ROOT)?.file, at('app.js'));
    assert.equal(resolveAppRequest('APP://SAREEA/app.js', ROOT)?.file, at('app.js'));
  });
  it('serves a file in a sub-folder of the renderer folder (stays inside)', () => {
    assert.equal(resolveAppRequest('app://sareea/img/logo.png', ROOT)?.file, at('img', 'logo.png'));
  });
});

describe('resolveAppRequest: what is refused', () => {
  const refused = [
    // path traversal, every spelling
    'app://sareea/../main.cjs',
    'app://sareea/..%2fmain.cjs',
    'app://sareea/..%2Fmain.cjs',
    'app://sareea/%2e%2e/main.cjs',
    'app://sareea/%2e%2e%2fmain.cjs',
    'app://sareea/a/../../main.cjs',
    'app://sareea/..%5cmain.cjs',
    'app://sareea/..\\main.cjs',
    'app://sareea/%252e%252e/main.cjs',
    'app://sareea/./index.html%2f..%2f..%2fpreload.cjs',
    'app://sareea/.%2e/main.cjs',
    'app://sareea/...%2fmain.cjs',
    // absolute paths, drive letters, streams, UNC
    'app://sareea/C:/Windows/win.ini',
    'app://sareea/C%3a/Windows/win.ini',
    'app://sareea/index.html:stream',
    'app://sareea//server/share/x.js',
    'app://sareea/\\\\server\\share\\x.js',
    // control characters, NUL, wildcards, trailing dots and spaces (Windows folds them)
    'app://sareea/index.html%00.js',
    'app://sareea/index.html%0a',
    'app://sareea/app.js.',
    'app://sareea/app.js%20',
    'app://sareea/app*.js',
    // things that are not served even though they could exist next to the page
    'app://sareea/main.cjs',
    'app://sareea/preload.cjs',
    'app://sareea/app.js.map',
    'app://sareea/package.json',
    'app://sareea/sub/',
    // wrong scheme, host, port or credentials
    'file:///C:/x/index.html',
    'https://sareea/index.html',
    'app://evil/index.html',
    'app://sareea.evil.test/index.html',
    'app://sareea:81/index.html',
    'app://user@sareea/index.html',
    'app://user:pw@sareea/index.html',
    'not a url',
    '',
  ];
  for (const u of refused) {
    it(`refuses ${JSON.stringify(u)}`, () => {
      assert.equal(resolveAppRequest(u, ROOT), null);
    });
  }

  it('never returns a path outside the root, whatever it is given', () => {
    const noise = ['..', '.', '%2e', '%2e%2e', '..%2f', '%2f', '\\', '/', ':', '%', '%zz', 'a b', 'ü', 'index.html', 'x.js', 'x.css', 'x.png'];
    for (const a of noise) {
      for (const b of noise) {
        for (const sep of ['/', '%2f', '%5c', '\\']) {
          const r = resolveAppRequest(`app://sareea/${a}${sep}${b}`, ROOT);
          if (r) assert.ok(r.file.toLowerCase().startsWith(ROOT.toLowerCase() + '\\'), `${a}${sep}${b} -> ${r.file}`);
        }
      }
    }
  });
});
