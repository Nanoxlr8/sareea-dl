import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatReply, LIMITS as LimitsForTest, LineSplitter, parseBridgeLine } from '../src/app/protocol.ts';

const line = (o: unknown) => JSON.stringify(o);
const add = (extra: Record<string, unknown> = {}) => ({ v: 1, id: 'r1', type: 'add', url: 'https://example.com/file.zip', ...extra });

function ok(l: string) {
  const r = parseBridgeLine(l);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.request;
}
function bad(l: string, part?: string) {
  const r = parseBridgeLine(l);
  assert.ok(!r.ok, 'expected a rejection');
  if (part) assert.ok(r.error.includes(part), `"${r.error}" should mention "${part}"`);
  return r;
}

describe('parseBridgeLine: ping', () => {
  it('accepts a ping with a string or integer id', () => {
    assert.deepEqual(ok(line({ v: 1, id: 'abc', type: 'ping' })), { type: 'ping', id: 'abc' });
    assert.deepEqual(ok(line({ v: 1, id: 7, type: 'ping' })), { type: 'ping', id: 7 });
  });
  it('refuses extra fields on a ping', () => {
    bad(line({ v: 1, id: 'a', type: 'ping', url: 'https://x.com' }), 'unknown field');
  });
});

describe('parseBridgeLine: add', () => {
  it('accepts a minimal add', () => {
    const r = ok(line(add()));
    assert.deepEqual(r, { type: 'add', id: 'r1', url: 'https://example.com/file.zip', fileName: null, referrer: null, pageUrl: null, cookie: null, userAgent: null });
  });
  it('accepts every optional field', () => {
    const r = ok(line(add({ fileName: 'my file.zip', referrer: 'https://example.com/page', pageUrl: 'https://example.com/', headers: { cookie: 'a=b; c=d', userAgent: 'Mozilla/5.0 Test' } })));
    assert.equal(r.type, 'add');
    if (r.type !== 'add') return;
    assert.equal(r.fileName, 'my file.zip');
    assert.equal(r.referrer, 'https://example.com/page');
    assert.equal(r.pageUrl, 'https://example.com/');
    assert.equal(r.cookie, 'a=b; c=d');
    assert.equal(r.userAgent, 'Mozilla/5.0 Test');
  });
  it('treats null and empty optional values as absent', () => {
    const r = ok(line(add({ fileName: '', referrer: null, headers: { cookie: '', userAgent: null }, pageUrl: null })));
    if (r.type !== 'add') return assert.fail();
    assert.equal(r.fileName, null);
    assert.equal(r.cookie, null);
    assert.equal(r.userAgent, null);
  });
  it('requires an http(s) URL', () => {
    bad(line({ v: 1, id: 'x', type: 'add' }), 'url is required');
    for (const url of ['ftp://a.com/x', 'file:///C:/x.exe', 'javascript:alert(1)', 'data:text/plain,hi', 'blob:https://a.com/1', 'not a url', '', 5]) {
      bad(line(add({ url })));
    }
  });
  it('limits every string', () => {
    bad(line(add({ url: 'https://a.com/' + 'a'.repeat(LimitsForTest.url) })), 'too long');
    bad(line(add({ fileName: 'a'.repeat(LimitsForTest.fileName + 1) })), 'fileName');
    bad(line(add({ referrer: 'https://a.com/' + 'a'.repeat(LimitsForTest.referrer) })), 'referrer');
    bad(line(add({ pageUrl: 'https://a.com/' + 'a'.repeat(LimitsForTest.pageUrl) })), 'pageUrl');
    bad(line(add({ headers: { cookie: 'a'.repeat(LimitsForTest.cookie + 1) } })), 'cookie');
    bad(line(add({ headers: { userAgent: 'a'.repeat(LimitsForTest.userAgent + 1) } })), 'userAgent');
    // exactly at the limit is fine
    ok(line(add({ fileName: 'a'.repeat(LimitsForTest.fileName), headers: { cookie: 'a'.repeat(LimitsForTest.cookie), userAgent: 'a'.repeat(LimitsForTest.userAgent) } })));
  });
  it('refuses header injection and control characters', () => {
    bad(line(add({ headers: { cookie: 'a=b\r\nX-Evil: 1' } })), 'control');
    bad(line(add({ headers: { cookie: 'a=b\nX-Evil: 1' } })), 'control');
    bad(line(add({ headers: { cookie: 'a=\u0000' } })), 'control');
    bad(line(add({ headers: { userAgent: 'x\r\ny' } })), 'control');
    bad(line(add({ fileName: 'a\nb.zip' })), 'control');
    bad(line(add({ fileName: 'a\u0000b.zip' })), 'control');
    ok(line(add({ headers: { cookie: 'a=b;\tc=d' } })));
  });
  it('refuses non-http referrers and page URLs', () => {
    bad(line(add({ referrer: 'about:blank' })));
    bad(line(add({ referrer: 'file:///C:/x' })));
    bad(line(add({ pageUrl: 'javascript:1' })));
  });
  it('refuses unknown fields, including unknown header names', () => {
    bad(line(add({ extra: 1 })), 'unknown field');
    bad(line(add({ headers: { authorization: 'Bearer x' } })), 'unknown header');
    bad(line(add({ headers: 'cookie=a' })), 'headers must be an object');
    bad(line(add({ headers: ['cookie'] })), 'headers must be an object');
  });
  it('refuses wrong types for strings', () => {
    bad(line(add({ fileName: 5 })), 'fileName');
    bad(line(add({ referrer: 5 })), 'referrer');
    bad(line(add({ headers: { cookie: 5 } })), 'cookie');
  });
});

describe('parseBridgeLine: framing, version and ids', () => {
  it('refuses invalid JSON and non-objects', () => {
    bad('not json', 'invalid JSON');
    bad('', 'invalid JSON');
    bad('[1,2]', 'object');
    bad('"x"', 'object');
    bad('null', 'object');
    bad('42', 'object');
  });
  it('requires version 1', () => {
    bad(line({ id: 'a', type: 'ping' }), 'version');
    bad(line({ v: 2, id: 'a', type: 'ping' }), 'version');
    bad(line({ v: '1', id: 'a', type: 'ping' }), 'version');
  });
  it('requires a sane id and reports it back when known', () => {
    bad(line({ v: 1, type: 'ping' }), 'id');
    bad(line({ v: 1, id: '', type: 'ping' }), 'id');
    bad(line({ v: 1, id: 'a'.repeat(65), type: 'ping' }), 'id');
    bad(line({ v: 1, id: -1, type: 'ping' }), 'id');
    bad(line({ v: 1, id: 1.5, type: 'ping' }), 'id');
    bad(line({ v: 1, id: {}, type: 'ping' }), 'id');
    bad(line({ v: 1, id: 'a\nb', type: 'ping' }), 'id');
    const r = bad(line({ v: 1, id: 'keep', type: 'nope' }), 'type');
    assert.equal(r.ok === false && r.id, 'keep');
  });
  it('refuses unknown request types', () => {
    bad(line({ v: 1, id: 'a', type: 'delete' }), 'type');
    bad(line({ v: 1, id: 'a' }), 'type');
  });
  it('refuses lines over the byte limit, counting bytes not characters', () => {
    bad(line(add({ fileName: 'x'.repeat(70000) })), 'too long');
    const wide = line(add({ fileName: 'é'.repeat(250) }));
    ok(wide);
    bad('{"v":1,"id":"a","type":"ping"}' + ' '.repeat(LimitsForTest.maxLineBytes), 'too long');
  });
});

describe('formatReply', () => {
  it('is one JSON line with v, id and ok', () => {
    assert.equal(formatReply('r1', true), '{"v":1,"id":"r1","ok":true}\n');
    assert.equal(formatReply(7, true), '{"v":1,"id":7,"ok":true}\n');
  });
  it('carries an error text only when not ok', () => {
    assert.equal(formatReply('r1', false, 'nope'), '{"v":1,"id":"r1","ok":false,"error":"nope"}\n');
    assert.equal(formatReply(null, false, 'bad'), '{"v":1,"id":null,"ok":false,"error":"bad"}\n');
    assert.equal(formatReply('r1', true, 'ignored'), '{"v":1,"id":"r1","ok":true}\n');
  });
});

describe('LineSplitter', () => {
  it('splits complete lines and keeps the remainder', () => {
    const s = new LineSplitter();
    assert.deepEqual(s.push('{"a":1}\n{"b":2}\n{"c"'), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(s.push(':3}\n'), ['{"c":3}']);
  });
  it('handles CRLF and skips blank lines', () => {
    const s = new LineSplitter();
    assert.deepEqual(s.push('a\r\n\r\n   \nb\n'), ['a', 'b']);
  });
  it('returns nothing for a partial line', () => {
    const s = new LineSplitter();
    assert.deepEqual(s.push('abc'), []);
    assert.deepEqual(s.push('def'), []);
    assert.deepEqual(s.push('\n'), ['abcdef']);
  });
  it('stops a client that never sends a newline', () => {
    const s = new LineSplitter(100);
    assert.deepEqual(s.push('x'.repeat(60)), []);
    assert.equal(s.push('x'.repeat(60)), null);
    assert.equal(s.push('\n'), null, 'stays dead once the limit was exceeded');
  });
  it('stops an oversized complete line', () => {
    const s = new LineSplitter(100);
    assert.equal(s.push('x'.repeat(101) + '\n'), null);
  });
  it('counts multi-byte characters as bytes', () => {
    const s = new LineSplitter(100);
    assert.equal(s.push('é'.repeat(60) + '\n'), null); // 120 bytes
    const t = new LineSplitter(100);
    assert.deepEqual(t.push('é'.repeat(40) + '\n'), ['é'.repeat(40)]);
  });
});
