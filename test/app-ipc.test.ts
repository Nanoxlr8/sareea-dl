import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP_INDEX_URL } from '../src/app/app-scheme.ts';
import {
  isDirAllowed, isInsideDir, isTrustedSender, validateAddRequest, validateHttpUrl, validateIds, validateProbeRequest, validateRemoveRequest,
  validateWatchId, MAX_IDS,
} from '../src/app/ipc.ts';

const ID1 = '3f2b8a3e-9c1d-4a52-8f10-0b9e7d4c1a11';
const ID2 = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'abcdEFGH1234_-xyz0987';

const goodAdd = () => ({ url: 'https://example.com/a.zip', fileName: null, dir: null, connections: 8, start: true, bridgeToken: null });

describe('validateHttpUrl', () => {
  it('accepts http and https and normalises', () => {
    const r = validateHttpUrl('  https://Example.com/a b'.replace(' b', '%20b'));
    assert.ok(r.ok);
    assert.equal(r.value, 'https://example.com/a%20b');
    assert.ok(validateHttpUrl('http://127.0.0.1:8080/x').ok);
  });
  it('refuses every other scheme', () => {
    for (const u of ['file:///C:/x', 'ftp://a.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://a.com/1', 'chrome://settings', 'mailto:a@b.c', '\\\\server\\share\\x']) {
      assert.ok(!validateHttpUrl(u).ok, u);
    }
  });
  it('refuses junk, whitespace, control characters and over-long input', () => {
    assert.ok(!validateHttpUrl('').ok);
    assert.ok(!validateHttpUrl('not a url').ok);
    assert.ok(!validateHttpUrl('https://a.com/x y').ok);
    assert.ok(!validateHttpUrl('https://a.com/x\ny').ok);
    assert.ok(!validateHttpUrl('https://a.com/\u0000').ok);
    assert.ok(!validateHttpUrl('https://a.com/' + 'a'.repeat(9000)).ok);
    for (const v of [null, undefined, 5, {}, []]) assert.ok(!validateHttpUrl(v).ok);
  });
});

describe('validateIds', () => {
  it('accepts uuid arrays and removes duplicates', () => {
    const r = validateIds([ID1, ID2, ID1]);
    assert.ok(r.ok);
    assert.deepEqual(r.value, [ID1, ID2]);
  });
  it('rejects paths, non-ids, wrong types and bad sizes', () => {
    assert.ok(!validateIds([]).ok);
    assert.ok(!validateIds('x').ok);
    assert.ok(!validateIds(['../../etc/passwd']).ok);
    assert.ok(!validateIds(['C:\\Windows\\System32\\calc.exe']).ok);
    assert.ok(!validateIds([ID1, 5]).ok);
    assert.ok(!validateIds(Array.from({ length: MAX_IDS + 1 }, () => ID1)).ok);
  });
  it('watch id may be null', () => {
    assert.deepEqual(validateWatchId(null), { ok: true, value: null });
    assert.ok(validateWatchId(ID1).ok);
    assert.ok(!validateWatchId('x').ok);
    assert.ok(!validateWatchId(undefined).ok);
  });
});

describe('validateAddRequest', () => {
  it('accepts a complete request', () => {
    const r = validateAddRequest(goodAdd());
    assert.ok(r.ok);
    assert.equal(r.value.connections, 8);
  });
  it('accepts name, folder, token and queue mode', () => {
    const r = validateAddRequest({ ...goodAdd(), fileName: 'x.zip', dir: 'D:\\dl', start: false, bridgeToken: TOKEN });
    assert.ok(r.ok);
    assert.equal(r.value.start, false);
    assert.equal(r.value.dir, 'D:\\dl');
  });
  it('rejects bad URLs', () => {
    for (const url of ['file:///C:/a.exe', 'ftp://a/b', 'x', 5, null]) assert.ok(!validateAddRequest({ ...goodAdd(), url }).ok, String(url));
  });
  it('limits connections to 1..16', () => {
    for (const connections of [0, 17, 99, -1, 2.5, '8', null, Number.NaN]) assert.ok(!validateAddRequest({ ...goodAdd(), connections }).ok, String(connections));
    for (const connections of [1, 16]) assert.ok(validateAddRequest({ ...goodAdd(), connections }).ok);
  });
  it('rejects relative or special folders', () => {
    for (const dir of ['downloads', '..\\x', '\\\\.\\pipe\\x', 'C:\\a\\..\\b', 5]) assert.ok(!validateAddRequest({ ...goodAdd(), dir }).ok, String(dir));
  });
  it('rejects bad names, tokens and flags', () => {
    assert.ok(!validateAddRequest({ ...goodAdd(), fileName: 'a'.repeat(256) }).ok);
    assert.ok(!validateAddRequest({ ...goodAdd(), fileName: 'a\u0000b' }).ok);
    assert.ok(!validateAddRequest({ ...goodAdd(), fileName: 5 }).ok);
    assert.ok(!validateAddRequest({ ...goodAdd(), bridgeToken: 'short' }).ok);
    assert.ok(!validateAddRequest({ ...goodAdd(), bridgeToken: 'has spaces and !! symbols' }).ok);
    assert.ok(!validateAddRequest({ ...goodAdd(), start: 'yes' }).ok);
  });
  it('requires exactly the known fields', () => {
    assert.ok(!validateAddRequest({ ...goodAdd(), extra: 1 }).ok);
    const missing: Record<string, unknown> = goodAdd();
    delete missing.start;
    assert.ok(!validateAddRequest(missing).ok);
    for (const v of [null, undefined, 'x', 5, [], [goodAdd()]]) assert.ok(!validateAddRequest(v).ok);
  });
});

describe('validateProbeRequest / validateRemoveRequest', () => {
  it('probe needs a URL and a token or null', () => {
    assert.ok(validateProbeRequest({ url: 'https://a.com/x', bridgeToken: null }).ok);
    assert.ok(validateProbeRequest({ url: 'https://a.com/x', bridgeToken: TOKEN }).ok);
    assert.ok(!validateProbeRequest({ url: 'file:///x', bridgeToken: null }).ok);
    assert.ok(!validateProbeRequest({ url: 'https://a.com/x' }).ok);
  });
  it('remove needs ids and a boolean', () => {
    assert.ok(validateRemoveRequest({ ids: [ID1], deleteFile: true }).ok);
    assert.ok(!validateRemoveRequest({ ids: [ID1], deleteFile: 'true' }).ok);
    assert.ok(!validateRemoveRequest({ ids: ['x'], deleteFile: false }).ok);
    assert.ok(!validateRemoveRequest({ ids: [ID1], deleteFile: false, more: 1 }).ok);
  });
});

describe('isTrustedSender', () => {
  const expected = APP_INDEX_URL;
  it('accepts our own page, ignoring hash and query', () => {
    assert.equal(expected, 'app://sareea/index.html');
    assert.ok(isTrustedSender(expected, expected));
    assert.ok(isTrustedSender(expected + '#x', expected));
    assert.ok(isTrustedSender(expected + '?a=1', expected));
    assert.ok(isTrustedSender('APP://SAREEA/index.html', expected), 'scheme and host are case-insensitive');
  });
  it('refuses other pages, other hosts, other schemes (file: included) and missing frames', () => {
    assert.ok(!isTrustedSender('app://sareea/other.html', expected));
    assert.ok(!isTrustedSender('app://sareea/index.html/x', expected));
    assert.ok(!isTrustedSender('app://sareea/INDEX.HTML', expected), 'the path is exact');
    assert.ok(!isTrustedSender('app://evil/index.html', expected));
    assert.ok(!isTrustedSender('app://sareea:8080/index.html', expected));
    assert.ok(!isTrustedSender('app://user:pw@sareea/index.html', expected));
    assert.ok(!isTrustedSender('file:///C:/Program%20Files/Sareea/resources/app.asar/dist/renderer/index.html', expected));
    assert.ok(!isTrustedSender('file:///C:/evil/index.html', expected));
    assert.ok(!isTrustedSender('https://sareea/index.html', expected));
    assert.ok(!isTrustedSender('https://example.com/dist/renderer/index.html', expected));
    assert.ok(!isTrustedSender('about:blank', expected));
    assert.ok(!isTrustedSender('devtools://devtools/bundled/inspector.html', expected));
    assert.ok(!isTrustedSender('', expected));
    assert.ok(!isTrustedSender(undefined, expected));
    assert.ok(!isTrustedSender(null, expected));
    assert.ok(!isTrustedSender('not a url', expected));
  });
});

describe('folder rules', () => {
  const def = 'C:\\Users\\Tester\\Downloads\\Sareea';
  it('isInsideDir compares whole path segments, case-insensitively', () => {
    assert.ok(isInsideDir(def, def));
    assert.ok(isInsideDir(def + '\\Video', def));
    assert.ok(isInsideDir('c:\\users\\tester\\downloads\\sareea\\VIDEO\\', def));
    assert.ok(!isInsideDir(def + '-evil', def), 'a sibling that shares a prefix is not inside');
    assert.ok(!isInsideDir('C:\\Users\\Tester\\Downloads', def));
  });
  it('allows the default tree and folders the user picked, nothing else', () => {
    const picked = ['D:\\media'];
    assert.ok(isDirAllowed(def, def, picked));
    assert.ok(isDirAllowed(def + '\\Music', def, picked));
    assert.ok(isDirAllowed('D:\\media', def, picked));
    assert.ok(isDirAllowed('D:\\media\\sub', def, picked));
    assert.ok(!isDirAllowed('C:\\Windows\\System32', def, picked));
    assert.ok(!isDirAllowed('D:\\other', def, picked));
    assert.ok(!isDirAllowed(def + '\\..\\..\\..\\Windows', def, picked));
    assert.ok(!isDirAllowed('relative', def, picked));
  });
});
