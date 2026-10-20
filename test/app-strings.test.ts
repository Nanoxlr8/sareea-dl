import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRtl, STRINGS, translate } from '../src/app/strings.ts';
import type { StringKey } from '../src/app/strings.ts';
import { formatDateTime, formatDuration, formatRate, formatSize, percent } from '../src/app/fmt.ts';
import { redact } from '../src/app/redact.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('strings table', () => {
  const enKeys = Object.keys(STRINGS.en) as StringKey[];
  it('has exactly the same keys in English and Arabic', () => {
    assert.deepEqual(Object.keys(STRINGS.ar).sort(), [...enKeys].sort());
  });
  it('has no empty strings', () => {
    for (const lang of ['en', 'ar'] as const) for (const k of enKeys) assert.ok(STRINGS[lang][k].trim().length > 0, `${lang}:${k}`);
  });
  it('uses the same placeholders in both languages', () => {
    for (const k of enKeys) assert.deepEqual(placeholders(STRINGS.ar[k]), placeholders(STRINGS.en[k]), k);
  });
  it('Arabic really is Arabic for the main labels', () => {
    for (const k of ['toolbar.add', 'toolbar.pause', 'cat.video', 'status.done', 'settings.title'] as StringKey[]) {
      assert.match(STRINGS.ar[k], /[؀-ۿ]/, k);
    }
  });
  it('translate fills placeholders and only RTL languages are RTL', () => {
    assert.equal(translate('en', 'bar.count', { n: 3 }), '3 downloads');
    assert.ok(translate('ar', 'bar.count', { n: 3 }).includes('3'));
    assert.equal(isRtl('ar'), true);
    assert.equal(isRtl('en'), false);
  });
  it('every data-i18n key used in the HTML and every t() key in the renderer exists', () => {
    const html = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'index.html'), 'utf8');
    const used = new Set<string>();
    for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);
    const code = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'main.ts'), 'utf8') + fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'detail.ts'), 'utf8');
    for (const m of code.matchAll(/\bt\('([a-zA-Z.]+)'/g)) used.add(m[1]);
    for (const m of code.matchAll(/ctx\.t\('([a-zA-Z.]+)'/g)) used.add(m[1]);
    for (const k of used) assert.ok(k in STRINGS.en, `missing string key ${k}`);
    assert.ok(used.size > 40);
  });
});

describe('formatting', () => {
  it('formatSize', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(1023), '1023 B');
    assert.equal(formatSize(1536), '1.50 KB');
    assert.equal(formatSize(10 * 1024 * 1024), '10.0 MB');
    assert.equal(formatSize(150 * 1024 * 1024), '150 MB');
    assert.equal(formatSize(5 * 1024 ** 3), '5.00 GB');
    assert.equal(formatSize(null), '');
    assert.equal(formatSize(-1), '');
    assert.equal(formatSize(Number.NaN), '');
    assert.equal(formatSize(2048, 'ar'), '2.00 ك.ب');
  });
  it('formatRate', () => {
    assert.equal(formatRate(0), '');
    assert.equal(formatRate(1024 * 1024), '1.00 MB/s');
    assert.equal(formatRate(1024 * 1024, 'ar'), '1.00 م.ب/ث');
  });
  it('formatDuration', () => {
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), '');
    assert.equal(formatDuration(5), '00:05');
    assert.equal(formatDuration(125), '02:05');
    assert.equal(formatDuration(3725), '1:02:05');
  });
  it('formatDateTime is ISO-style', () => {
    assert.equal(formatDateTime(new Date(2026, 9, 20, 7, 5)), '2026-10-20 07:05');
    assert.equal(formatDateTime('not a date'), '');
  });
  it('percent is clamped and safe for unknown sizes', () => {
    assert.equal(percent(50, 200), 25);
    assert.equal(percent(300, 200), 100);
    assert.equal(percent(5, null), 0);
    assert.equal(percent(5, 0), 0);
  });
});

describe('redact', () => {
  it('drops query strings, fragments and credentials from URLs', () => {
    assert.equal(redact('GET https://example.com/a/b.zip?token=SECRET&x=1#frag failed'), 'GET https://example.com/a/b.zip?[redacted] failed');
    assert.equal(redact('see https://user:pw@example.com/x'), 'see https://[redacted]@example.com/x');
    assert.equal(redact('http://host/path'), 'http://host/path');
  });
  it('masks cookie and authorization header values', () => {
    assert.equal(redact('Cookie: sid=abc123; other=1'), 'Cookie: [redacted]');
    assert.equal(redact('set-cookie=abc'), 'set-cookie=[redacted]');
    assert.equal(redact('{"cookie":"sid=abc","userAgent":"x"}'.replace('"userAgent":"x"', '"u":1')).includes('abc'), false);
    assert.equal(redact('Authorization: Bearer abcdef123456'), 'Authorization: [redacted]');
    assert.equal(redact('proxy-authorization: Basic Zm9vOmJhcg=='), 'proxy-authorization: [redacted]');
  });
  it('masks bare bearer and basic tokens', () => {
    assert.equal(redact('token was Bearer abc.def-123_456'), 'token was Bearer [redacted]');
  });
  it('leaves ordinary text alone', () => {
    assert.equal(redact('download 3f2b8a3e finished: setup.exe'), 'download 3f2b8a3e finished: setup.exe');
  });
});
