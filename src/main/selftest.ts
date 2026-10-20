/**
 * `--self-test`: proves the whole chain works inside the real app, then the caller quits.
 * It runs in a throw-away profile (temp userData) and checks, through the real window:
 *   - the page loaded with no console errors (CSP violations show up as console errors) and has no Node access
 *   - hostile IPC calls from the page are refused and create nothing
 *   - the named-pipe bridge answers ping, rejects bad lines, and a bridge "add" opens the prefilled Add dialog
 *   - clicking "Start now" downloads https://proof.ovh.net/files/10Mb.dat to the expected size
 *   - the finished row shows in the list; switching to Arabic flips the page to RTL
 * Result goes to stdout and (with --self-test-out=file) to a JSON file. Exit code 0 = pass.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { AppController } from './controller.ts';
import type { Logger } from './logger.ts';

export const SELF_TEST_URL = 'https://proof.ovh.net/files/10Mb.dat';
export const SELF_TEST_SIZE = 10 * 1024 * 1024;

export interface SelfTestEnv {
  controller: AppController;
  win: BrowserWindow;
  pipe: string;
  log: Logger;
  outFile: string | null;
  screenshotDir: string | null;
  downloadDir: string;
  consoleErrors: string[];
  packaged: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | false | undefined> | T | null | false | undefined, timeoutMs: number, everyMs = 150): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Send lines to the pipe and collect one reply per line (or until the server closes). */
function pipeExchange(pipe: string, payload: string, expectReplies: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    sock.setEncoding('utf8');
    let buf = '';
    const out: unknown[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('pipe exchange timed out'));
    }, 8000);
    const finish = () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(out);
    };
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        try {
          out.push(JSON.parse(buf.slice(0, i)));
        } catch {
          out.push({ unparsable: buf.slice(0, i) });
        }
        buf = buf.slice(i + 1);
        if (out.length >= expectReplies) return finish();
      }
    });
    sock.on('close', finish);
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export async function runSelfTest(env: SelfTestEnv): Promise<number> {
  const { controller, win, log } = env;
  const checks: Check[] = [];
  const started = Date.now();
  const ev = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail });
    log.info(`self-test ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
  };
  const shot = async (name: string): Promise<void> => {
    if (!env.screenshotDir) return;
    try {
      fs.mkdirSync(env.screenshotDir, { recursive: true });
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(env.screenshotDir, `${name}.png`), img.toPNG());
    } catch (e) {
      log.warn(`screenshot ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const summary: Record<string, unknown> = {};
  try {
    // 1. the page is up, sandboxed and clean
    await waitFor('the UI to be ready', () => ev<boolean>(`document.body && document.body.dataset.ready === '1'`), 20000);
    const page = await ev<{ api: string; fn: number; node: string; csp: string; dir: string; title: string }>(`({
      api: typeof window.sareea, fn: Object.keys(window.sareea || {}).length,
      node: typeof require + ',' + typeof process + ',' + typeof module + ',' + typeof Buffer,
      csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '',
      dir: document.documentElement.dir, title: document.title })`);
    check('page exposes window.sareea and nothing from Node', page.api === 'object' && page.fn >= 15 && page.node === 'undefined,undefined,undefined,undefined', JSON.stringify(page.node));
    check('strict CSP meta present', page.csp.includes("default-src 'self'") && page.csp.includes("connect-src 'none'") && page.csp.includes("object-src 'none'"));
    check('window title and LTR layout in English', page.title === 'Sareea DL' && page.dir === 'ltr');

    // 2. hostile calls from the page are refused and create nothing
    const hostile = await ev<{ ok: boolean }[]>(`Promise.all([
      window.sareea.add({url:'file:///C:/Windows/System32/calc.exe',fileName:null,dir:null,connections:8,start:true,bridgeToken:null}),
      window.sareea.add({url:'ftp://example.com/a.bin',fileName:null,dir:null,connections:8,start:true,bridgeToken:null}),
      window.sareea.add({url:'https://example.test/a.bin',fileName:null,dir:'C:\\\\Windows\\\\System32',connections:8,start:true,bridgeToken:null}),
      window.sareea.add({url:'https://example.test/a.bin',fileName:null,dir:null,connections:99,start:true,bridgeToken:null}),
      window.sareea.add({url:'https://example.test/a.bin',fileName:null,dir:null,connections:8,start:true,bridgeToken:null,extra:1}),
      window.sareea.openFile('C:\\\\Windows\\\\System32\\\\calc.exe'),
      window.sareea.openFolder('../../x'),
      window.sareea.remove({ids:['x'],deleteFile:true}),
      window.sareea.setSettings({defaultDir:'C:\\\\Windows'}),
      window.sareea.setSettings({bogus:1}),
      window.sareea.setSettings({maxConcurrent:9999}),
      window.sareea.probe({url:'javascript:alert(1)',bridgeToken:null}),
    ])`);
    check('12 hostile IPC calls are all refused', hostile.length === 12 && hostile.every((r) => r.ok === false), hostile.map((r) => (r.ok ? '1' : '0')).join(''));
    check('refused calls created no downloads', controller.queue.list().length === 0);

    // 3. the bridge
    const [pong] = await pipeExchange(env.pipe, '{"v":1,"id":"t1","type":"ping"}\n', 1);
    check('bridge answers ping', JSON.stringify(pong) === '{"v":1,"id":"t1","ok":true}', JSON.stringify(pong));
    const bad = await pipeExchange(
      env.pipe,
      '{"v":1,"id":"b1","type":"add","url":"ftp://x.test/a.zip"}\n{"v":2,"id":"b2","type":"ping"}\nnot json\n{"v":1,"id":"b4","type":"add","url":"https://x.test/a.zip","headers":{"cookie":"a=b\\r\\nX: y"}}\n',
      4,
    );
    check('bridge rejects ftp, wrong version, junk and header injection', bad.length === 4 && bad.every((r) => (r as { ok: boolean }).ok === false), JSON.stringify(bad).slice(0, 300));
    const big = await pipeExchange(env.pipe, 'x'.repeat(70000) + '\n', 1);
    check('bridge refuses an oversized line', (big[0] as { ok?: boolean }).ok === false);
    check('bridge adds nothing by itself', controller.queue.list().length === 0);

    const [added] = await pipeExchange(
      env.pipe,
      JSON.stringify({ v: 1, id: 'a1', type: 'add', url: SELF_TEST_URL, referrer: 'https://proof.ovh.net/', headers: { cookie: 'selftest=1', userAgent: 'SareeaSelfTest/1' } }) + '\n',
      1,
    );
    check('bridge add is accepted', (added as { ok?: boolean }).ok === true, JSON.stringify(added));

    // 4. the prefilled Add dialog appears in the real UI; its probe works
    await waitFor('the Add dialog to open prefilled', () => ev<boolean>(`document.getElementById('addDialog').open && document.getElementById('addUrl').value.includes('10Mb.dat')`), 10000);
    await waitFor('the probe result in the dialog', () => ev<boolean>(`document.getElementById('addInfo').className.includes('ok')`), 30000);
    const probeText = await ev<string>(`document.getElementById('probeText').textContent`);
    const nameInDialog = await ev<string>(`document.getElementById('addName').value`);
    const folderInDialog = await ev<string>(`document.getElementById('addFolder').value`);
    check('dialog shows size and resume support', probeText.includes('10.0 MB') && probeText.includes('Resume supported'), probeText);
    check('dialog filled the name and a category folder', nameInDialog === '10Mb.dat' && folderInDialog.startsWith(env.downloadDir) && /General$/.test(folderInDialog), `${nameInDialog} -> ${folderInDialog}`);
    const note = await ev<string>(`document.getElementById('addSource').textContent`);
    check('dialog says the browser cookie is not saved', /cookie/i.test(note), note);
    await shot('01-add-dialog');

    // 5. click Start now, download through the whole stack
    await ev(`document.getElementById('addStart').click()`);
    const item = await waitFor('the download to be added', () => controller.queue.list()[0], 10000);
    log.info('self-test download added: ' + item.id.slice(0, 8));
    let detailShot = false;
    const t0 = Date.now();
    const final = await waitFor(
      'the download to finish',
      async () => {
        const it = controller.queue.get(item.id);
        if (!it) return null;
        if (!detailShot && it.status === 'downloading' && it.downloaded > 1024 * 1024) {
          detailShot = true;
          await ev(`(() => { const tr = document.querySelector('#rows tr'); if (tr) tr.click(); document.getElementById('btnDetails').click(); })()`);
          await sleep(700);
          await shot('02-downloading-with-details');
        }
        if (it.status === 'error' || it.status === 'cancelled') throw new Error(`download ended as ${it.status}: ${it.error ?? ''}`);
        return it.status === 'done' ? it : null;
      },
      180000,
      250,
    );
    const seconds = (Date.now() - t0) / 1000;
    const finalPath = final.path as string;
    const st = fs.statSync(finalPath);
    check('downloaded file has the expected size', st.size === SELF_TEST_SIZE, `${st.size} bytes`);
    check('file landed in the category folder under the test folder', path.dirname(finalPath).startsWith(env.downloadDir), finalPath);
    const leftovers = fs.readdirSync(path.dirname(finalPath)).filter((f) => f.endsWith('.part') || f.endsWith('.sareea.json'));
    check('no .part or sidecar left behind', leftovers.length === 0, leftovers.join(','));
    const sha = createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
    summary.sha256 = sha;
    summary.file = path.basename(finalPath);
    summary.bytes = st.size;
    summary.seconds = Number(seconds.toFixed(1));
    summary.avgMBps = Number((st.size / 1048576 / Math.max(seconds, 0.1)).toFixed(2));

    // 6. the list shows it
    const rowText = await waitFor('the finished row in the list', async () => {
      const t = await ev<string>(`(document.querySelector('#rows tr') || {}).innerText || ''`);
      return t.includes('Completed') && t.includes('10Mb.dat') ? t : null;
    }, 10000);
    check('list row shows Completed, 10.0 MB, 100%', rowText.includes('10.0 MB') && rowText.includes('100%'), rowText.replace(/\s+/g, ' '));
    const detailText = await ev<string>(`document.getElementById('detail').innerText`);
    check('detail panel shows size and save path', detailText.includes('10Mb.dat') && detailText.includes('General'), detailText.replace(/\s+/g, ' ').slice(0, 120));
    await sleep(350);
    await shot('03-completed');

    // 6b. context menu and settings dialog
    await ev(`(() => { const tr = document.querySelector('#rows tr'); const r = tr.getBoundingClientRect();
      tr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 160, clientY: r.top + 8 })); })()`);
    const menuInfo = await ev<{ n: number; enabledOpen: boolean }>(`(() => { const items = [...document.querySelectorAll('#menu .menu-item')];
      return { n: items.length, enabledOpen: !!items[0] && !items[0].disabled && items[0].innerText.trim() === 'Open' }; })()`);
    check('right-click menu lists 9 actions with Open enabled for a finished file', menuInfo.n === 9 && menuInfo.enabledOpen, JSON.stringify(menuInfo));
    await shot('05-context-menu');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await ev(`document.getElementById('btnSettings').click()`);
    await waitFor('the settings dialog', () => ev<boolean>(`document.getElementById('settingsDialog').open`), 3000);
    const folderShown = await ev<string>(`document.getElementById('setFolder').value`);
    check('settings dialog shows the default folder', folderShown === env.downloadDir, folderShown);
    // browser integration section: reads the registry, writes nothing (the buttons are not pressed here)
    const integ = await waitFor('the browser integration status', async () => {
      const t = await ev<string>(`document.getElementById('integStatus').innerText`);
      return t.includes('Chrome:') ? t : null;
    }, 8000);
    const integButtons = await ev<string>(`['integInstall', 'integRemove', 'integFolder'].map((id) => document.getElementById(id).innerText.trim() + (document.getElementById(id).disabled ? ' (disabled)' : '')).join(' | ')`);
    check('settings dialog shows the browser integration status and its three buttons', integ.includes('Edge:') && integButtons.startsWith('Install browser integration |'), `${integ} / ${integButtons}`);
    await sleep(200);
    await shot('06-settings');
    await ev(`document.getElementById('settingsClose').click()`);

    // 7. Arabic / RTL
    await ev(`window.sareea.setSettings({language:'ar', theme:'dark'})`);
    const rtl = await waitFor('RTL layout', () => ev<boolean>(`document.documentElement.dir === 'rtl' && document.getElementById('btnAdd').innerText.includes('إضافة')`), 5000);
    check('Arabic switches the page to RTL with Arabic labels', rtl === true);
    await sleep(400);
    await shot('04-arabic-rtl-dark');
    await ev(`window.sareea.setSettings({language:'en', theme:'light'})`);
    await waitFor('English again', () => ev<boolean>(`document.documentElement.dir === 'ltr'`), 5000);

    // 7b. the clipboard watcher starts and stops without trouble (it only offers real download links)
    const clipOn = await ev<{ ok: boolean }>(`window.sareea.setSettings({clipboardWatch:true})`);
    await sleep(1400);
    const clipOff = await ev<{ ok: boolean }>(`window.sareea.setSettings({clipboardWatch:false})`);
    check('clipboard watch can be switched on and off', clipOn.ok === true && clipOff.ok === true);

    // 8. nothing went wrong in the page
    check('no console errors or CSP violations in the page', env.consoleErrors.length === 0, env.consoleErrors.join(' | ').slice(0, 400));
  } catch (e) {
    check('self-test run', false, e instanceof Error ? e.message : String(e));
    await shot('99-failure');
  }

  const failed = checks.filter((c) => !c.ok);
  const result = {
    result: failed.length === 0 ? 'PASS' : 'FAIL',
    passed: checks.length - failed.length,
    failed: failed.length,
    url: SELF_TEST_URL,
    packaged: env.packaged,
    electron: process.versions.electron,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    ...summary,
    checks,
  };
  const text = JSON.stringify(result, null, 2);
  process.stdout.write(`SELF-TEST ${result.result} (${result.passed}/${checks.length})\n${text}\n`);
  if (env.outFile) {
    try {
      fs.writeFileSync(env.outFile, text);
    } catch {
      /* stdout already has it */
    }
  }
  return failed.length === 0 ? 0 : 1;
}
