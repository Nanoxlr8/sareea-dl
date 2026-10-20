import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, isAbsoluteWindowsPath, sanitizeLoadedSettings, validateSettingsPatch } from '../src/app/settings.ts';

const PROFILE = 'C:\\Users\\Tester';

describe('defaultSettings', () => {
  it('uses %USERPROFILE%\\Downloads\\Sareea and the required defaults', () => {
    const d = defaultSettings(PROFILE);
    assert.equal(d.defaultDir, 'C:\\Users\\Tester\\Downloads\\Sareea');
    assert.equal(d.categorySubfolders, true);
    assert.equal(d.startWithWindows, false, 'no auto-start by default');
    assert.equal(d.clipboardWatch, false, 'clipboard watch off by default');
    assert.equal(d.browserAutoStart, false, 'browser auto-start off by default');
    assert.equal(d.theme, 'system');
    assert.equal(d.language, 'en');
    assert.equal(d.defaultConnections, 8);
    assert.equal(d.speedLimitKiBps, 0);
  });
});

describe('isAbsoluteWindowsPath', () => {
  it('accepts drive and UNC folders', () => {
    assert.ok(isAbsoluteWindowsPath('C:\\Users\\Tester\\Downloads'));
    assert.ok(isAbsoluteWindowsPath('D:/media/in'));
    assert.ok(isAbsoluteWindowsPath('\\\\server\\share\\folder'));
  });
  it('rejects relative, device, extended, traversal and stream paths', () => {
    for (const p of ['downloads', '.\\x', '..\\x', '\\Windows', 'C:', 'C:x', '\\\\.\\pipe\\x', '\\\\?\\C:\\x', 'C:\\a\\..\\b', 'C:\\x:stream', 'C:\\a<b', 'C:\\a|b', 'C:\\a?b']) {
      assert.ok(!isAbsoluteWindowsPath(p), p);
    }
  });
  it('rejects non-strings, empty, NUL and over-long paths', () => {
    assert.ok(!isAbsoluteWindowsPath(5));
    assert.ok(!isAbsoluteWindowsPath(null));
    assert.ok(!isAbsoluteWindowsPath(''));
    assert.ok(!isAbsoluteWindowsPath('C:\\a\0b'));
    assert.ok(!isAbsoluteWindowsPath('C:\\' + 'a'.repeat(1100)));
  });
});

describe('validateSettingsPatch', () => {
  it('accepts valid partial changes', () => {
    const r = validateSettingsPatch({ maxConcurrent: 5, theme: 'dark', language: 'ar', startWithWindows: true, speedLimitKiBps: 2048, defaultDir: 'D:\\dl' });
    assert.ok(r.ok);
    assert.deepEqual(r.value, { maxConcurrent: 5, theme: 'dark', language: 'ar', startWithWindows: true, speedLimitKiBps: 2048, defaultDir: 'D:\\dl' });
  });
  it('accepts an empty patch', () => {
    assert.deepEqual(validateSettingsPatch({}), { ok: true, value: {} });
  });
  it('rejects unknown keys', () => {
    assert.ok(!validateSettingsPatch({ nope: 1 }).ok);
    assert.ok(!validateSettingsPatch({ __proto__x: 1 }).ok);
  });
  it('enforces ranges and types', () => {
    assert.ok(!validateSettingsPatch({ maxConcurrent: 0 }).ok);
    assert.ok(!validateSettingsPatch({ maxConcurrent: 11 }).ok);
    assert.ok(!validateSettingsPatch({ maxConcurrent: 2.5 }).ok);
    assert.ok(!validateSettingsPatch({ maxConcurrent: '3' }).ok);
    assert.ok(!validateSettingsPatch({ defaultConnections: 17 }).ok);
    assert.ok(!validateSettingsPatch({ defaultConnections: 0 }).ok);
    assert.ok(validateSettingsPatch({ defaultConnections: 16 }).ok);
    assert.ok(validateSettingsPatch({ defaultConnections: 1 }).ok);
    assert.ok(!validateSettingsPatch({ speedLimitKiBps: -1 }).ok);
    assert.ok(!validateSettingsPatch({ speedLimitKiBps: Number.NaN }).ok);
    assert.ok(!validateSettingsPatch({ speedLimitKiBps: 1e12 }).ok);
    assert.ok(!validateSettingsPatch({ theme: 'blue' }).ok);
    assert.ok(!validateSettingsPatch({ language: 'fr' }).ok);
    assert.ok(!validateSettingsPatch({ closeToTray: 'yes' }).ok);
    assert.ok(!validateSettingsPatch({ defaultDir: 'relative' }).ok);
  });
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 5, 'x', [], [1]]) assert.ok(!validateSettingsPatch(v).ok);
  });
});

describe('sanitizeLoadedSettings', () => {
  const d = defaultSettings(PROFILE);
  it('keeps valid fields and falls back to defaults for bad ones', () => {
    const s = sanitizeLoadedSettings({ maxConcurrent: 6, theme: 'purple', language: 'ar', defaultDir: 'nope', extra: 1, startWithWindows: 'yes' }, d);
    assert.equal(s.maxConcurrent, 6);
    assert.equal(s.theme, 'system');
    assert.equal(s.language, 'ar');
    assert.equal(s.defaultDir, d.defaultDir);
    assert.equal(s.startWithWindows, false);
    assert.ok(!('extra' in s));
  });
  it('returns the defaults for junk input', () => {
    for (const v of [null, undefined, 3, 'x', []]) assert.deepEqual(sanitizeLoadedSettings(v, d), d);
  });
});
