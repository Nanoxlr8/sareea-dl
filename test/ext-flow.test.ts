import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCaptureSettings } from '../src/extension/capture.ts';
import type { CaptureSettings } from '../src/extension/capture.ts';
import { handleBrowserDownload, handleMenuClick } from '../src/extension/flow.ts';
import type { BrowserDownload, FlowDeps } from '../src/extension/flow.ts';
import { buildAddMessage, classifyReply, outcomeText } from '../src/extension/native.ts';
import type { NativeOutcome } from '../src/extension/native.ts';

interface Harness {
  deps: FlowDeps;
  log: {
    sent: Record<string, unknown>[];
    cancelled: number[];
    reissued: string[];
    outcomes: NativeOutcome[];
    permissionRequests: string[];
    declined: string[];
    sites: string[];
    contains: string[][];
    getAll: { url: string }[];
  };
  marks: Set<string>;
}

function harness(opts: { settings?: Partial<CaptureSettings>; grants?: string[]; reply?: NativeOutcome; userAgrees?: boolean; requestThrows?: boolean; marks?: string[] } = {}): Harness {
  const settings: CaptureSettings = { ...defaultCaptureSettings(), ...(opts.settings ?? {}) };
  const grants = new Set(opts.grants ?? []);
  const marks = new Set(opts.marks ?? []);
  const log: Harness['log'] = { sent: [], cancelled: [], reissued: [], outcomes: [], permissionRequests: [], declined: [], sites: [], contains: [], getAll: [] };
  const deps: FlowDeps = {
    getSettings: async () => settings,
    now: () => 1_700_000_000_000,
    ownId: 'ourextensionid',
    userAgent: 'TestAgent/1.0',
    cookies: {
      contains: async (q) => {
        log.contains.push(q.origins);
        return q.origins.every((o) => grants.has(o));
      },
      getAll: async (d) => {
        log.getAll.push(d);
        return [{ name: 'sid', value: 'S3CRET' }];
      },
    },
    send: async (m) => {
      log.sent.push(m);
      return opts.reply ?? { kind: 'ok' };
    },
    cancelDownload: async (id) => {
      log.cancelled.push(id);
    },
    reissue: async (url) => {
      marks.add(url);
      log.reissued.push(url);
    },
    takeReissuedMark: async (url) => marks.delete(url),
    onOutcome: (o) => log.outcomes.push(o),
    rememberSite: async (o) => {
      log.sites.push(o);
    },
    requestPermission: async (pattern) => {
      log.permissionRequests.push(pattern);
      if (opts.requestThrows) throw new Error('This function must be called during a user gesture');
      if (opts.userAgrees) grants.add(pattern);
      return opts.userAgrees === true;
    },
    rememberDeclined: async (o) => {
      log.declined.push(o);
      settings.declinedOrigins.push(o);
    },
  };
  return { deps, log, marks };
}

const item = (over: Partial<BrowserDownload> = {}): BrowserDownload => ({
  id: 7,
  url: 'https://example.com/files/setup.zip',
  filename: 'C:\\Users\\me\\Downloads\\setup.zip',
  referrer: 'https://example.com/get',
  totalBytes: 5_000_000,
  ...over,
});

describe('browser download flow', () => {
  it('hands a matching download to the app, then cancels and erases the browser copy', async () => {
    const h = harness();
    assert.equal(await handleBrowserDownload(item(), h.deps), 'captured');
    assert.equal(h.log.sent.length, 1);
    assert.deepEqual(h.log.sent[0], {
      type: 'add',
      url: 'https://example.com/files/setup.zip',
      fileName: 'setup.zip',
      referrer: 'https://example.com/get',
      headers: { userAgent: 'TestAgent/1.0' },
    });
    assert.deepEqual(h.log.cancelled, [7]);
  });

  it('sends no cookie and never touches the cookies API when the origin was not granted', async () => {
    const h = harness();
    await handleBrowserDownload(item(), h.deps);
    assert.equal(h.log.getAll.length, 0);
    const headers = h.log.sent[0].headers as Record<string, string>;
    assert.equal('cookie' in headers, false);
    assert.ok(!JSON.stringify(h.log.sent).includes('S3CRET'));
  });

  it('sends the cookie for exactly that URL when the origin was granted', async () => {
    const h = harness({ grants: ['https://example.com/*'] });
    await handleBrowserDownload(item(), h.deps);
    assert.deepEqual(h.log.getAll, [{ url: 'https://example.com/files/setup.zip' }]);
    assert.deepEqual((h.log.sent[0].headers as Record<string, string>).cookie, 'sid=S3CRET');
  });

  it('a grant for another site is not used', async () => {
    const h = harness({ grants: ['https://other.example/*'] });
    await handleBrowserDownload(item(), h.deps);
    assert.equal(h.log.getAll.length, 0);
  });

  it('leaves the download to the browser when the app is not reachable, and flags it', async () => {
    for (const reply of [{ kind: 'app-not-running' }, { kind: 'host-missing' }, { kind: 'failed' }, { kind: 'rejected', error: 'duplicate' }] as NativeOutcome[]) {
      const h = harness({ reply });
      assert.equal(await handleBrowserDownload(item(), h.deps), 'left-to-browser');
      assert.deepEqual(h.log.cancelled, [], reply.kind);
      assert.equal(h.log.reissued.length, 0, 'no restart needed: the original download just carries on');
      assert.deepEqual(h.log.outcomes, [reply]);
    }
  });

  it('skips downloads that do not match, are paused or are switched off, without contacting the host', async () => {
    const cases: [Partial<BrowserDownload>, Partial<CaptureSettings>][] = [
      [{ url: 'https://example.com/page.html', filename: 'page.html', totalBytes: 10 }, {}],
      [{}, { enabled: false }],
      [{}, { pausedUntil: 1_700_000_000_000 + 60_000 }],
      [{ url: 'blob:https://example.com/abc' }, {}],
      [{ incognito: true }, {}],
    ];
    for (const [over, s] of cases) {
      const h = harness({ settings: s });
      assert.equal(await handleBrowserDownload(item(over), h.deps), 'skipped');
      assert.equal(h.log.sent.length, 0);
      assert.equal(h.log.cancelled.length, 0);
    }
  });

  it('never captures a download this extension started itself (no loop)', async () => {
    const h = harness();
    assert.equal(await handleBrowserDownload(item({ byExtensionId: 'ourextensionid' }), h.deps), 'skipped');
    assert.equal(h.log.sent.length, 0);
  });

  it('a URL marked as re-issued is let through once, then captured again', async () => {
    const h = harness({ marks: ['https://example.com/files/setup.zip'] });
    assert.equal(await handleBrowserDownload(item(), h.deps), 'skipped');
    assert.equal(h.log.sent.length, 0);
    assert.equal(await handleBrowserDownload(item(), h.deps), 'captured');
  });

  it('remembers the site (origin only) so the popup can offer to allow it', async () => {
    const h = harness();
    await handleBrowserDownload(item({ url: 'https://files.example.com:8443/a/b.zip?token=x' }), h.deps);
    assert.deepEqual(h.log.sites, ['https://files.example.com:8443']);
  });
});

describe('context menu flow', () => {
  it('asks for the permission on the click when the site is new, and sends the cookie if granted', async () => {
    const h = harness({ userAgrees: true });
    const r = await handleMenuClick({ linkUrl: 'https://example.com/private/a.bin', pageUrl: 'https://example.com/account?tab=files' }, h.deps);
    assert.equal(r, 'sent');
    assert.deepEqual(h.log.permissionRequests, ['https://example.com/*']);
    assert.equal((h.log.sent[0].headers as Record<string, string>).cookie, 'sid=S3CRET');
    assert.equal(h.log.sent[0].referrer, 'https://example.com/account?tab=files');
    assert.deepEqual(h.log.getAll, [{ url: 'https://example.com/private/a.bin' }]);
  });

  it('when the user says no it still downloads, without cookies, and does not ask again', async () => {
    const h = harness({ userAgrees: false });
    assert.equal(await handleMenuClick({ linkUrl: 'https://example.com/a.bin' }, h.deps), 'sent');
    assert.equal(h.log.getAll.length, 0);
    assert.equal('cookie' in (h.log.sent[0].headers as Record<string, string>), false);
    assert.deepEqual(h.log.declined, ['https://example.com']);
    await handleMenuClick({ linkUrl: 'https://example.com/b.bin' }, h.deps);
    assert.equal(h.log.permissionRequests.length, 1, 'a declined site is not asked again');
  });

  it('a refused request (no user gesture) is not remembered as the user saying no', async () => {
    const h = harness({ requestThrows: true });
    assert.equal(await handleMenuClick({ linkUrl: 'https://example.com/a.bin' }, h.deps), 'sent');
    assert.deepEqual(h.log.declined, []);
    assert.equal(h.log.getAll.length, 0);
    assert.equal('cookie' in (h.log.sent[0].headers as Record<string, string>), false);
  });

  it('does not ask when the setting says not to, or when already granted', async () => {
    const h1 = harness({ settings: { askCookiesOnMenu: false } });
    await handleMenuClick({ linkUrl: 'https://example.com/a.bin' }, h1.deps);
    assert.equal(h1.log.permissionRequests.length, 0);
    assert.equal(h1.log.getAll.length, 0);
    const h2 = harness({ grants: ['https://example.com/*'] });
    await handleMenuClick({ linkUrl: 'https://example.com/a.bin' }, h2.deps);
    assert.equal(h2.log.permissionRequests.length, 0);
    assert.equal(h2.log.getAll.length, 1);
  });

  it('uses the media source when there is no link, and ignores non-http targets', async () => {
    const h = harness();
    assert.equal(await handleMenuClick({ srcUrl: 'https://cdn.example.com/v.mp4' }, h.deps), 'sent');
    assert.equal(h.log.sent[0].url, 'https://cdn.example.com/v.mp4');
    const h2 = harness();
    assert.equal(await handleMenuClick({ linkUrl: 'javascript:alert(1)', srcUrl: 'blob:https://x/1' }, h2.deps), 'ignored');
    assert.equal(h2.log.sent.length, 0);
    assert.equal(h2.log.permissionRequests.length, 0);
  });

  it('gives only the origin of the page as referrer for another site, and no pageUrl without a referrer', async () => {
    const h = harness();
    await handleMenuClick({ linkUrl: 'https://cdn.other.com/a.bin', pageUrl: 'https://example.com/secret/path?token=1' }, h.deps);
    assert.equal(h.log.sent[0].referrer, 'https://example.com/');
    const h2 = harness();
    await handleMenuClick({ linkUrl: 'http://cdn.other.com/a.bin', pageUrl: 'https://example.com/secret/path?token=1' }, h2.deps);
    assert.equal('referrer' in h2.log.sent[0], false);
    assert.equal('pageUrl' in h2.log.sent[0], false, 'the app would use pageUrl as Referer');
  });

  it('falls back to a browser download (marked) when the app cannot take it', async () => {
    const h = harness({ reply: { kind: 'app-not-running' } });
    assert.equal(await handleMenuClick({ linkUrl: 'https://example.com/a.zip' }, h.deps), 'fallback');
    assert.deepEqual(h.log.reissued, ['https://example.com/a.zip']);
    // and the re-issued download is then not captured again
    assert.equal(await handleBrowserDownload(item({ url: 'https://example.com/a.zip' }), h.deps), 'skipped');
    assert.equal(h.log.sent.length, 1);
  });
});

describe('native messages', () => {
  it('buildAddMessage leaves out empty fields', () => {
    assert.deepEqual(buildAddMessage({ url: 'https://x.com/a.zip' }), { type: 'add', url: 'https://x.com/a.zip' });
    assert.deepEqual(buildAddMessage({ url: 'https://x.com/a.zip', fileName: 'a.zip', cookie: 'a=b', userAgent: 'UA', referrer: 'https://x.com/', pageUrl: 'https://x.com/p' }), {
      type: 'add', url: 'https://x.com/a.zip', fileName: 'a.zip', referrer: 'https://x.com/', pageUrl: 'https://x.com/p', headers: { cookie: 'a=b', userAgent: 'UA' },
    });
  });

  it('classifyReply', () => {
    assert.deepEqual(classifyReply({ v: 1, ok: true }, null), { kind: 'ok' });
    assert.deepEqual(classifyReply({ v: 1, ok: false, error: 'app-not-running' }, null), { kind: 'app-not-running' });
    assert.deepEqual(classifyReply({ v: 1, ok: false, error: 'duplicate' }, null), { kind: 'rejected', error: 'duplicate' });
    assert.deepEqual(classifyReply(undefined, 'Specified native messaging host not found.'), { kind: 'host-missing' });
    assert.deepEqual(classifyReply(undefined, 'Native host has exited.'), { kind: 'failed' });
    assert.deepEqual(classifyReply(null, null), { kind: 'failed' });
    assert.deepEqual(classifyReply({ ok: 'maybe' }, null), { kind: 'failed' });
  });

  it('outcome texts say "Sareea DL not running" for the badge', () => {
    assert.equal(outcomeText({ kind: 'app-not-running' }), 'Sareea DL not running');
  });
});
