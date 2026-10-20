import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseName, decideCapture, defaultCaptureSettings, DEFAULT_EXTENSIONS, extensionOf, knownSize, parseExtensionList, pauseMinutesLeft,
  referrerFor, sanitizeSettings,
} from '../src/extension/capture.ts';
import type { CaptureSettings, DownloadInfo } from '../src/extension/capture.ts';

const NOW = 1_700_000_000_000;
const MB = 1024 * 1024;
const settings = (over: Partial<CaptureSettings> = {}): CaptureSettings => ({ ...defaultCaptureSettings(), ...over });
const dl = (over: Partial<DownloadInfo> = {}): DownloadInfo => ({ url: 'https://example.com/files/setup.zip', ...over });

describe('download capture decision', () => {
  it('captures the default file types', () => {
    for (const ext of ['zip', '7z', 'rar', 'exe', 'msi', 'iso', 'mp4', 'mkv', 'mp3', 'flac', 'pdf']) {
      const d = decideCapture(dl({ url: `https://example.com/a.${ext}` }), settings(), NOW);
      assert.deepEqual(d, { capture: true, reason: 'extension' }, ext);
    }
    assert.ok(DEFAULT_EXTENSIONS.includes('zip') && !DEFAULT_EXTENSIONS.includes('ts'), 'a .ts file is TypeScript more often than video');
  });

  it('uses the browser file name first, then the URL path', () => {
    assert.equal(decideCapture(dl({ url: 'https://x.com/download?id=7', filename: 'C:\\Users\\me\\Downloads\\report.pdf' }), settings(), NOW).capture, true);
    assert.equal(decideCapture(dl({ url: 'https://x.com/files/a.ISO?token=1' }), settings(), NOW).capture, true);
    assert.equal(decideCapture(dl({ url: 'https://x.com/page', filename: 'C:\\d\\notes.txt' }), settings(), NOW).capture, false);
  });

  it('captures by size when the type is unknown, only at or above the minimum', () => {
    const u = 'https://x.com/blob.dat';
    assert.deepEqual(decideCapture(dl({ url: u, totalBytes: MB }), settings(), NOW), { capture: true, reason: 'size' });
    assert.deepEqual(decideCapture(dl({ url: u, fileSize: 5 * MB }), settings(), NOW), { capture: true, reason: 'size' });
    assert.equal(decideCapture(dl({ url: u, totalBytes: MB - 1 }), settings(), NOW).capture, false);
    assert.equal(decideCapture(dl({ url: u, totalBytes: -1 }), settings(), NOW).capture, false, 'unknown size');
    assert.equal(decideCapture(dl({ url: u }), settings(), NOW).capture, false);
    assert.equal(decideCapture(dl({ url: u, totalBytes: 50 * MB }), settings({ minSizeMB: 0 }), NOW).capture, false, '0 turns the size rule off');
    assert.equal(decideCapture(dl({ url: u, totalBytes: 3 * MB }), settings({ minSizeMB: 4 }), NOW).capture, false);
  });

  it('honours a custom file-type list', () => {
    const s = settings({ extensions: ['torrent'] });
    assert.equal(decideCapture(dl({ url: 'https://x.com/a.torrent' }), s, NOW).capture, true);
    assert.equal(decideCapture(dl({ url: 'https://x.com/a.zip' }), s, NOW).capture, false);
  });

  it('never captures anything but http and https', () => {
    for (const url of ['blob:https://x.com/1234', 'data:text/plain;base64,AAAA', 'file:///C:/a.zip', 'ftp://x.com/a.zip', 'chrome://downloads/a.zip', 'filesystem:https://x.com/a.zip', 'not a url', '']) {
      assert.deepEqual(decideCapture(dl({ url }), settings(), NOW), { capture: false, reason: 'not-http' }, url);
    }
  });

  it('does nothing when capture is off or paused, and resumes when the pause ends', () => {
    assert.deepEqual(decideCapture(dl(), settings({ enabled: false }), NOW), { capture: false, reason: 'disabled' });
    assert.deepEqual(decideCapture(dl(), settings({ pausedUntil: NOW + 1000 }), NOW), { capture: false, reason: 'paused' });
    assert.equal(decideCapture(dl(), settings({ pausedUntil: NOW }), NOW).capture, true);
    assert.equal(decideCapture(dl(), settings({ pausedUntil: NOW - 1 }), NOW).capture, true);
  });

  it('skips incognito downloads and downloads this extension started itself', () => {
    assert.deepEqual(decideCapture(dl({ incognito: true }), settings(), NOW), { capture: false, reason: 'incognito' });
    assert.deepEqual(decideCapture(dl({ byExtensionId: 'me' }), settings(), NOW, 'me'), { capture: false, reason: 'ours' });
    assert.equal(decideCapture(dl({ byExtensionId: 'other' }), settings(), NOW, 'me').capture, true);
  });

  it('pause helper rounds up to whole minutes', () => {
    assert.equal(pauseMinutesLeft({ pausedUntil: NOW + 1 }, NOW), 1);
    assert.equal(pauseMinutesLeft({ pausedUntil: NOW + 5 * 60_000 }, NOW), 5);
    assert.equal(pauseMinutesLeft({ pausedUntil: NOW }, NOW), 0);
    assert.equal(pauseMinutesLeft({ pausedUntil: 0 }, NOW), 0);
  });
});

describe('capture helpers', () => {
  it('extensionOf and baseName', () => {
    assert.equal(extensionOf('a/b/c.tar.GZ'), 'gz');
    assert.equal(extensionOf('C:\\x\\.hidden'), '');
    assert.equal(extensionOf('noext'), '');
    assert.equal(extensionOf('dot.'), '');
    assert.equal(baseName('C:\\Users\\me\\Downloads\\a.zip'), 'a.zip');
    assert.equal(baseName('/tmp/a.zip'), 'a.zip');
    assert.equal(baseName(''), null);
    assert.equal(baseName('C:\\dir\\'), null);
    assert.equal(baseName('x'.repeat(300)), null);
  });

  it('knownSize takes the larger known value', () => {
    assert.equal(knownSize({ totalBytes: 10, fileSize: 20 }), 20);
    assert.equal(knownSize({ totalBytes: -1 }), -1);
    assert.equal(knownSize({}), -1);
  });

  it('parseExtensionList cleans, lower-cases and de-duplicates', () => {
    assert.deepEqual(parseExtensionList('zip, .7Z;PDF  zip\nmp4'), ['zip', '7z', 'pdf', 'mp4']);
    assert.deepEqual(parseExtensionList('a/b, c d, <script>, ok'), ['c', 'd', 'ok']);
    assert.deepEqual(parseExtensionList(''), []);
  });

  it('sanitizeSettings falls back per field and drops junk', () => {
    assert.deepEqual(sanitizeSettings(null), defaultCaptureSettings());
    assert.deepEqual(sanitizeSettings('x'), defaultCaptureSettings());
    const s = sanitizeSettings({ enabled: 'yes', extensions: ['ZIP', 5, 'bad ext', '.rar'], minSizeMB: -3, pausedUntil: 'x', askCookiesOnMenu: false, declinedOrigins: ['https://a.com', 7] });
    assert.equal(s.enabled, true);
    assert.deepEqual(s.extensions, ['zip', 'bad', 'ext', 'rar']);
    assert.equal(s.minSizeMB, 1);
    assert.equal(s.pausedUntil, 0);
    assert.equal(s.askCookiesOnMenu, false);
    assert.deepEqual(s.declinedOrigins, ['https://a.com']);
  });

  it('referrerFor follows the default policy and never leaks a path to another site', () => {
    assert.equal(referrerFor('https://a.com/page?x=1#top', 'https://a.com/f.zip'), 'https://a.com/page?x=1');
    assert.equal(referrerFor('https://a.com/page?token=secret', 'https://cdn.b.com/f.zip'), 'https://a.com/');
    assert.equal(referrerFor('https://a.com/page', 'http://b.com/f.zip'), null, 'https -> http sends nothing');
    assert.equal(referrerFor('http://a.com/page', 'https://b.com/f.zip'), 'http://a.com/');
    assert.equal(referrerFor('chrome://x', 'https://b.com/f.zip'), null);
    assert.equal(referrerFor(undefined, 'https://b.com/f.zip'), null);
    assert.equal(referrerFor('https://u:p@a.com/page', 'https://a.com/f.zip'), 'https://a.com/page', 'credentials stripped');
  });
});
