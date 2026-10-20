import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileNameFromUrl, parseContentDisposition, sanitizeFileName, uniqueName } from '../src/filename.ts';
import { rmDir, tmpDir } from './helpers.ts';

describe('sanitizeFileName', () => {
  it('strips directories and traversal', () => {
    assert.equal(sanitizeFileName('../../evil.exe'), 'evil.exe');
    assert.equal(sanitizeFileName('..\\..\\Windows\\System32\\evil.dll'), 'evil.dll');
    assert.equal(sanitizeFileName('/etc/passwd'), 'passwd');
    assert.equal(sanitizeFileName('C:\\temp\\a.txt'), 'a.txt');
    assert.equal(sanitizeFileName('..'), 'download');
    assert.equal(sanitizeFileName('....'), 'download');
    assert.equal(sanitizeFileName('a..b.txt'), 'a.b.txt');
  });

  it('prefixes reserved device names', () => {
    assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
    assert.equal(sanitizeFileName('con'), '_con');
    assert.equal(sanitizeFileName('Nul.tar.gz'), '_Nul.tar.gz');
    for (const n of ['PRN', 'AUX', 'COM1', 'COM9', 'LPT1', 'LPT9']) assert.equal(sanitizeFileName(`${n}.log`), `_${n}.log`);
    assert.equal(sanitizeFileName('COM10.txt'), 'COM10.txt', 'COM10 is not reserved');
    assert.equal(sanitizeFileName('console.txt'), 'console.txt');
    assert.equal(sanitizeFileName('CON .txt'), '_CON .txt');
  });

  it('replaces forbidden characters and drops control characters', () => {
    assert.equal(sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
    assert.equal(sanitizeFileName('tab\there\u0000nul\u001f.txt'), 'tabherenul.txt');
    assert.equal(sanitizeFileName('exe\u202Etxt.gpj'), 'exetxt.gpj', 'bidi override removed');
  });

  it('trims trailing dots and spaces', () => {
    assert.equal(sanitizeFileName('report.pdf. . '), 'report.pdf');
    assert.equal(sanitizeFileName('   name.txt'), 'name.txt');
    assert.equal(sanitizeFileName('...'), 'download');
    assert.equal(sanitizeFileName(''), 'download');
    assert.equal(sanitizeFileName('   '), 'download');
    assert.equal(sanitizeFileName('', 'fallback.bin'), 'fallback.bin');
  });

  it('keeps Arabic and other unicode names', () => {
    assert.equal(sanitizeFileName('تقرير الربع الثالث.pdf'), 'تقرير الربع الثالث.pdf');
  });

  it('caps the length but keeps the extension', () => {
    const long = 'a'.repeat(500) + '.tar.gz';
    const out = sanitizeFileName(long);
    assert.ok(out.length <= 200, `length ${out.length}`);
    assert.ok(out.endsWith('.tar.gz'));
    const noExt = sanitizeFileName('b'.repeat(500));
    assert.equal(noExt.length, 200);
    const emoji = sanitizeFileName('\u{1F600}'.repeat(150) + '.txt');
    assert.ok(emoji.length <= 200);
    assert.ok(!/[\ud800-\udbff]$/.test(emoji.replace(/\.txt$/, '')), 'no lone surrogate');
  });

  it('is idempotent and never returns a path', () => {
    for (const s of ['../../evil.exe', 'CON.txt', 'a:b', 'x'.repeat(300), 'ok.txt']) {
      const once = sanitizeFileName(s);
      assert.equal(sanitizeFileName(once), once);
      assert.equal(path.basename(once), once);
    }
  });
});

describe('uniqueName', () => {
  let dir: string;
  before(() => {
    dir = tmpDir();
  });
  after(() => rmDir(dir));

  it('returns the name when free, then numbers it', () => {
    assert.equal(uniqueName(dir, 'a.zip'), 'a.zip');
    fs.writeFileSync(path.join(dir, 'a.zip'), 'x');
    assert.equal(uniqueName(dir, 'a.zip'), 'a (1).zip');
    fs.writeFileSync(path.join(dir, 'a (1).zip'), 'x');
    assert.equal(uniqueName(dir, 'a.zip'), 'a (2).zip');
  });

  it('handles no extension, dotfiles and .tar.gz', () => {
    fs.writeFileSync(path.join(dir, 'README'), 'x');
    assert.equal(uniqueName(dir, 'README'), 'README (1)');
    fs.writeFileSync(path.join(dir, '.env'), 'x');
    assert.equal(uniqueName(dir, '.env'), '.env (1)');
    fs.writeFileSync(path.join(dir, 'src.tar.gz'), 'x');
    assert.equal(uniqueName(dir, 'src.tar.gz'), 'src (1).tar.gz');
  });
});

describe('parseContentDisposition', () => {
  it('reads plain and quoted filename', () => {
    assert.equal(parseContentDisposition('attachment; filename=report.pdf'), 'report.pdf');
    assert.equal(parseContentDisposition('attachment; filename="my report.pdf"'), 'my report.pdf');
    assert.equal(parseContentDisposition('attachment; filename="a;b.txt"'), 'a;b.txt');
    assert.equal(parseContentDisposition('attachment; filename="say \\"hi\\".txt"'), 'say "hi".txt');
    assert.equal(parseContentDisposition('inline'), null);
    assert.equal(parseContentDisposition(undefined), null);
    assert.equal(parseContentDisposition(''), null);
  });

  it('decodes filename*=UTF-8 (Arabic)', () => {
    const arabic = 'تقرير.pdf';
    const enc = encodeURIComponent(arabic);
    assert.equal(parseContentDisposition(`attachment; filename*=UTF-8''${enc}`), arabic);
    assert.equal(parseContentDisposition(`attachment; filename*=utf-8''${enc}`), arabic);
  });

  it('prefers filename* over filename', () => {
    const enc = encodeURIComponent('تقرير.pdf');
    assert.equal(
      parseContentDisposition(`attachment; filename="fallback.pdf"; filename*=UTF-8''${enc}`),
      'تقرير.pdf',
    );
    assert.equal(
      parseContentDisposition(`attachment; filename*=UTF-8''${enc}; filename="fallback.pdf"`),
      'تقرير.pdf',
    );
  });

  it('handles iso-8859-1 and the euro-sign example from RFC 5987', () => {
    assert.equal(parseContentDisposition("attachment; filename*=iso-8859-1'en'%A3%20rates"), '\u00a3 rates');
    assert.equal(parseContentDisposition("attachment; filename*=UTF-8''%e2%82%ac%20rates"), '\u20ac rates');
  });

  it('repairs UTF-8 bytes that Node decoded as latin1', () => {
    const raw = Buffer.from('تقرير.pdf', 'utf8').toString('latin1');
    assert.equal(parseContentDisposition(`attachment; filename="${raw}"`), 'تقرير.pdf');
  });

  it('percent-decodes an encoded plain filename', () => {
    assert.equal(parseContentDisposition('attachment; filename="a%20b.txt"'), 'a b.txt');
  });

  it('survives garbage', () => {
    assert.equal(parseContentDisposition("attachment; filename*=UTF-8''%ff%fe"), null);
    assert.equal(parseContentDisposition('attachment; filename='), null);
  });

  it('feeds sanitize safely: traversal in the header is neutralised', () => {
    assert.equal(sanitizeFileName(parseContentDisposition('attachment; filename="../../evil.exe"') ?? ''), 'evil.exe');
    assert.equal(sanitizeFileName(parseContentDisposition('attachment; filename="CON.txt"') ?? ''), '_CON.txt');
  });
});

describe('fileNameFromUrl', () => {
  it('uses the last path segment, decoded, ignoring the query', () => {
    assert.equal(fileNameFromUrl('https://example.com/files/a%20b.zip?token=abc'), 'a b.zip');
    assert.equal(fileNameFromUrl('https://example.com/dir/'), 'dir');
    assert.equal(fileNameFromUrl('https://example.com/'), null);
    assert.equal(fileNameFromUrl('not a url'), null);
    assert.equal(fileNameFromUrl(`https://example.com/${encodeURIComponent('ملف.pdf')}`), 'ملف.pdf');
  });
});
