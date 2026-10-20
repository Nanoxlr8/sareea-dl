import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryOf, extensionOf, isDownloadableExtension, isRiskyFile, looksLikeDownloadLink, matchesFilter, subfolderFor,
} from '../src/app/categories.ts';

describe('extensionOf', () => {
  it('returns the last extension in lower case', () => {
    assert.equal(extensionOf('Report.PDF'), 'pdf');
    assert.equal(extensionOf('a.tar.gz'), 'gz');
    assert.equal(extensionOf('C:\\dir\\movie.MKV'), 'mkv');
  });
  it('returns empty for no extension, dotfiles and trailing dots', () => {
    assert.equal(extensionOf('README'), '');
    assert.equal(extensionOf('.bashrc'), '');
    assert.equal(extensionOf('name.'), '');
  });
});

describe('categoryOf', () => {
  it('maps the sidebar categories by extension', () => {
    assert.equal(categoryOf('a.zip'), 'compressed');
    assert.equal(categoryOf('a.7z'), 'compressed');
    assert.equal(categoryOf('b.docx'), 'documents');
    assert.equal(categoryOf('b.PDF'), 'documents');
    assert.equal(categoryOf('c.mp3'), 'music');
    assert.equal(categoryOf('c.flac'), 'music');
    assert.equal(categoryOf('d.exe'), 'programs');
    assert.equal(categoryOf('d.msi'), 'programs');
    assert.equal(categoryOf('e.mp4'), 'video');
    assert.equal(categoryOf('e.mkv'), 'video');
  });
  it('falls back to "other" for unknown, missing and empty names', () => {
    assert.equal(categoryOf('10Mb.dat'), 'other');
    assert.equal(categoryOf('noext'), 'other');
    assert.equal(categoryOf(''), 'other');
    assert.equal(categoryOf(null), 'other');
    assert.equal(categoryOf(undefined), 'other');
  });
  it('has a folder name for every category', () => {
    assert.equal(subfolderFor('compressed'), 'Compressed');
    assert.equal(subfolderFor('video'), 'Video');
    assert.equal(subfolderFor('other'), 'General');
  });
});

describe('matchesFilter', () => {
  it('all matches everything', () => {
    assert.ok(matchesFilter('all', 'x.dat', 'error'));
  });
  it('finished and unfinished split on status', () => {
    assert.ok(matchesFilter('finished', 'a.zip', 'done'));
    assert.ok(!matchesFilter('finished', 'a.zip', 'paused'));
    assert.ok(matchesFilter('unfinished', 'a.zip', 'paused'));
    assert.ok(matchesFilter('unfinished', 'a.zip', 'error'));
    assert.ok(!matchesFilter('unfinished', 'a.zip', 'done'));
  });
  it('category filters use the file name', () => {
    assert.ok(matchesFilter('video', 'clip.mp4', 'downloading'));
    assert.ok(!matchesFilter('video', 'clip.zip', 'downloading'));
    assert.ok(!matchesFilter('documents', 'weird.dat', 'done'));
  });
});

describe('looksLikeDownloadLink', () => {
  it('accepts a plain http(s) link to a known file type', () => {
    assert.ok(looksLikeDownloadLink('https://example.com/files/setup.exe'));
    assert.ok(looksLikeDownloadLink('http://example.com/a/b.ZIP?token=1'));
    assert.ok(looksLikeDownloadLink('  https://example.com/a.mp4  '));
  });
  it('rejects pages, other schemes, free text and multiple links', () => {
    assert.ok(!looksLikeDownloadLink('https://example.com/index.html'));
    assert.ok(!looksLikeDownloadLink('https://example.com/'));
    assert.ok(!looksLikeDownloadLink('ftp://example.com/a.zip'));
    assert.ok(!looksLikeDownloadLink('file:///C:/a.zip'));
    assert.ok(!looksLikeDownloadLink('javascript:alert(1)//a.zip'));
    assert.ok(!looksLikeDownloadLink('see https://example.com/a.zip please'));
    assert.ok(!looksLikeDownloadLink('https://a.com/a.zip https://b.com/b.zip'));
    assert.ok(!looksLikeDownloadLink(''));
    assert.ok(!looksLikeDownloadLink('https://example.com/' + 'a'.repeat(9000) + '.zip'));
  });
  it('knows which extensions count as downloadable', () => {
    assert.ok(isDownloadableExtension('ZIP'));
    assert.ok(!isDownloadableExtension('html'));
  });
});

describe('isRiskyFile', () => {
  it('flags programs, scripts and macro documents', () => {
    for (const n of ['a.exe', 'a.MSI', 'a.bat', 'a.ps1', 'a.vbs', 'a.js', 'a.lnk', 'a.jar', 'a.docm', 'a.iso']) assert.ok(isRiskyFile(n), n);
  });
  it('lets ordinary documents and media through', () => {
    for (const n of ['a.pdf', 'a.docx', 'a.mp4', 'a.zip', 'a.txt', 'a.dat']) assert.ok(!isRiskyFile(n), n);
  });
});
