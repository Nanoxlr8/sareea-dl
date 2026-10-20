import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCookieHeader, cookieHeaderFor, MAX_COOKIE_HEADER, originFromPattern, originOf, originPattern } from '../src/extension/cookies.ts';
import type { CookieDeps, CookieLike } from '../src/extension/cookies.ts';

function fakeDeps(grants: string[], jar: CookieLike[]) {
  const calls = { contains: [] as string[][], getAll: [] as { url: string }[] };
  const deps: CookieDeps = {
    async contains(q) {
      calls.contains.push(q.origins);
      return q.origins.every((o) => grants.includes(o));
    },
    async getAll(d) {
      calls.getAll.push(d);
      return jar;
    },
  };
  return { deps, calls };
}

describe('cookie permission gating', () => {
  it('without a grant the cookies API is never called', async () => {
    const { deps, calls } = fakeDeps([], [{ name: 'sid', value: 'secret' }]);
    assert.equal(await cookieHeaderFor('https://example.com/a/b.zip?x=1', deps), null);
    assert.deepEqual(calls.contains, [['https://example.com/*']]);
    assert.equal(calls.getAll.length, 0, 'cookies.getAll must not run without a grant');
  });

  it('a grant for another origin does not count (other site, other scheme, other port)', async () => {
    const grants = ['https://example.com/*'];
    for (const url of ['https://other.com/a.zip', 'http://example.com/a.zip', 'https://sub.example.com/a.zip', 'https://example.com:8443/a.zip']) {
      const { deps, calls } = fakeDeps(grants, [{ name: 'sid', value: 'v' }]);
      assert.equal(await cookieHeaderFor(url, deps), null, url);
      assert.equal(calls.getAll.length, 0, url);
    }
  });

  it('with a grant it asks only for the exact download URL', async () => {
    const { deps, calls } = fakeDeps(['https://example.com/*'], [{ name: 'sid', value: 'abc' }, { name: 'theme', value: 'dark' }]);
    assert.equal(await cookieHeaderFor('https://example.com/a/b.zip?x=1', deps), 'sid=abc; theme=dark');
    assert.deepEqual(calls.getAll, [{ url: 'https://example.com/a/b.zip?x=1' }]);
  });

  it('non-http URLs never reach the permission or cookie APIs', async () => {
    const { deps, calls } = fakeDeps(['https://example.com/*'], [{ name: 'a', value: 'b' }]);
    for (const url of ['blob:https://example.com/1', 'file:///C:/a.zip', 'ftp://example.com/a', 'junk']) assert.equal(await cookieHeaderFor(url, deps), null);
    assert.equal(calls.contains.length, 0);
    assert.equal(calls.getAll.length, 0);
  });

  it('an API error means no cookies, not a crash', async () => {
    const bad: CookieDeps = {
      contains: async () => {
        throw new Error('boom');
      },
      getAll: async () => {
        throw new Error('boom');
      },
    };
    assert.equal(await cookieHeaderFor('https://example.com/a.zip', bad), null);
    const bad2: CookieDeps = { contains: async () => true, getAll: async () => { throw new Error('boom'); } };
    assert.equal(await cookieHeaderFor('https://example.com/a.zip', bad2), null);
  });
});

describe('cookie header and origin helpers', () => {
  it('originPattern is one origin only', () => {
    assert.equal(originPattern('https://example.com/a/b?c=d'), 'https://example.com/*');
    assert.equal(originPattern('http://127.0.0.1:8080/x.zip'), 'http://127.0.0.1:8080/*');
    assert.equal(originPattern('https://example.com:443/x'), 'https://example.com/*');
    assert.equal(originPattern('ftp://example.com/x'), null);
    assert.equal(originPattern('nonsense'), null);
    assert.equal(originOf('https://u:p@example.com/x'), 'https://example.com');
  });

  it('originFromPattern accepts single http(s) origins only', () => {
    assert.equal(originFromPattern('https://example.com/*'), 'https://example.com');
    assert.equal(originFromPattern('http://127.0.0.1:8080/*'), 'http://127.0.0.1:8080');
    for (const p of ['https://*/*', 'http://*/*', 'https://*.example.com/*', '<all_urls>', '*://example.com/*', 'https://example.com/path/*', 'file:///*']) assert.equal(originFromPattern(p), null, p);
  });

  it('buildCookieHeader skips unusable cookies and refuses an oversize header', () => {
    assert.equal(buildCookieHeader([]), null);
    assert.equal(buildCookieHeader([{ name: 'a', value: 'b' }, { name: 'c', value: '' }]), 'a=b; c=');
    assert.equal(buildCookieHeader([{ name: 'a;b', value: 'x' }, { name: 'ok', value: 'v\r\nX: y' }, { name: '', value: 'z' }, { name: 'fine', value: '1' }]), 'fine=1');
    assert.equal(buildCookieHeader([{ name: 'big', value: 'x'.repeat(MAX_COOKIE_HEADER) }]), null);
  });
});
