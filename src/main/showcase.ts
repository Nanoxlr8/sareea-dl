/**
 * `--self-test-showcase=<dir>`: stages a few downloads in the real window and saves PNG screenshots of the UI
 * (used for the README images). TEST FLAVOUR ONLY, like selftest.ts: main.ts reaches it only through
 * `__SAREEA_TEST_HOOKS__`, and the release gate fails a package that contains the switch.
 *
 * It uses public test files, a data folder from SAREEA_DL_TEST_DIR (or a throw-away temp folder), never the real profile,
 * and a global speed limit so that one download is still running when the pictures are taken.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AppController } from './controller.ts';
import type { Logger } from './logger.ts';

export interface ShowcaseEnv {
  controller: AppController;
  win: BrowserWindow;
  log: Logger;
  outDir: string;
}

// Real public files (small installers, a song, a PDF, source tarballs), one host per download.
const F = {
  sevenZip: 'https://www.7-zip.org/a/7z2409-x64.exe',
  song: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  pdf: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
  kernel: 'https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.tar.xz',
  gcc: 'https://ftp.gnu.org/gnu/gcc/gcc-14.2.0/gcc-14.2.0.tar.xz',
  video: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4',
  node: 'https://nodejs.org/dist/v24.14.1/node-v24.14.1-x64.msi',
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | false | undefined> | T | null | false | undefined, timeoutMs: number, everyMs = 200): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

export async function runShowcase(env: ShowcaseEnv): Promise<number> {
  const { controller, win, log } = env;
  const ev = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  fs.mkdirSync(env.outDir, { recursive: true });

  // capturePage can hand back the previous frame when the window is not in front, so a picture that is byte-identical
  // to the one before is taken again (every step of the scenario changes the screen).
  let lastShot = '';
  const shot = async (name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> => {
    let png = Buffer.alloc(0);
    let size = { width: 0, height: 0 };
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(500 + attempt * 300);
      await Promise.race([ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`), sleep(2000)]);
      win.webContents.invalidate();
      const img = clip ? await win.webContents.capturePage(clip) : await win.webContents.capturePage();
      png = img.toPNG();
      size = img.getSize();
      if (clip || png.toString('base64') !== lastShot) break;
    }
    if (!clip) lastShot = png.toString('base64');
    fs.writeFileSync(path.join(env.outDir, `${name}.png`), png);
    log.info(`showcase ${name}.png ${size.width}x${size.height}`);
  };
  const add = async (url: string, fileName: string | null, start: boolean, connections = 8): Promise<string> => {
    const r = await ev<{ ok: boolean; id?: string; error?: string }>(
      `window.sareea.add(${JSON.stringify({ url, fileName, dir: null, connections, start, bridgeToken: null })})`,
    );
    if (!r.ok || !r.id) throw new Error(`add failed: ${r.error}`);
    return r.id;
  };
  const settle = (id: string, status: string, minBytes = 0, ms = 120000) =>
    waitFor(`${id.slice(0, 8)} to be ${status}`, () => {
      const it = controller.queue.get(id);
      if (it && (it.status === 'error' || it.status === 'cancelled')) throw new Error(`download ended as ${it.status}: ${it.error ?? ''}`);
      return it && it.status === status && it.downloaded >= minBytes ? it : null;
    }, ms);
  const pickRow = (name: string) =>
    ev(`(() => { const tr = [...document.querySelectorAll('#rows tr')].find((r) => r.innerText.includes(${JSON.stringify(name)})); if (tr) tr.click(); })()`);
  const rect = (sel: string) =>
    ev<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);

  try {
    await waitFor('the UI to be ready', () => ev<boolean>(`document.body && document.body.dataset.ready === '1'`), 20000);
    await ev(`window.sareea.setSettings({language:'en', theme:'light', maxConcurrent:3, speedLimitKiBps:0, closeToTray:true})`);

    // three finished files at full speed
    const finished = [await add(F.sevenZip, null, true, 4), await add(F.song, null, true, 4), await add(F.pdf, null, true, 1)];
    for (const id of finished) await settle(id, 'done', 0, 120000);

    // slow the rest down so a download is still running while the pictures are taken
    await ev(`window.sareea.setSettings({speedLimitKiBps:2048})`);
    const kernel = await add(F.kernel, null, true, 8);
    await settle(kernel, 'downloading', 2 * 1024 * 1024);
    const gcc = await add(F.gcc, null, true, 3);
    await settle(gcc, 'downloading', 3 * 1024 * 1024);
    await ev(`window.sareea.pause([${JSON.stringify(gcc)}])`);
    await settle(gcc, 'paused');
    await add(F.video, null, false, 6); // queued, waits for "Start queue"
    await settle(kernel, 'downloading', 22 * 1024 * 1024);

    // 1. main window with the detail panel
    await pickRow('linux-6.12.tar.xz');
    await ev(`(() => { if (document.getElementById('detail').hidden) document.getElementById('btnDetails').click(); })()`);
    await waitFor('the detail panel', () => ev<boolean>(`!document.getElementById('detail').hidden && document.getElementById('detailName').textContent.includes('linux')`), 5000);
    await sleep(2500);
    await shot('main-window');
    await shot('detail-panel', await rect('#detail'));

    // 2. context menu
    await ev(`(() => { const tr = [...document.querySelectorAll('#rows tr')].find((r) => r.innerText.includes('gcc-14.2.0.tar.xz'));
      tr.click(); const r = tr.getBoundingClientRect();
      tr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 220, clientY: r.top + 10 })); })()`);
    await shot('context-menu');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await pickRow('linux-6.12.tar.xz');

    // 3. Add dialog (prefilled through the same event the bridge uses; never reads the real clipboard)
    win.webContents.send('sareea:ev:showAdd', { url: F.node, fileName: null, bridgeToken: null, hasCookie: false, source: 'drop' });
    await waitFor('the Add dialog', () => ev<boolean>(`document.getElementById('addDialog').open`), 5000);
    await waitFor('the probe result', () => ev<boolean>(`document.getElementById('addInfo').className.includes('ok')`), 30000);
    await shot('add-dialog');
    await ev(`document.getElementById('addCancel').click()`);

    // 4. Settings
    await ev(`document.getElementById('btnSettings').click()`);
    await waitFor('the settings dialog', () => ev<boolean>(`document.getElementById('settingsDialog').open`), 3000);
    await waitFor('the browser integration status', () => ev<boolean>(`document.getElementById('integStatus').innerText.trim() !== ''`), 8000);
    await shot('settings');
    await ev(`document.getElementById('settingsClose').click()`);

    // 5. dark theme, then Arabic RTL (light and dark)
    await ev(`window.sareea.setSettings({theme:'dark'})`);
    await sleep(600);
    await shot('dark-theme');
    await ev(`window.sareea.setSettings({language:'ar', theme:'light'})`);
    await waitFor('RTL layout', () => ev<boolean>(`document.documentElement.dir === 'rtl'`), 5000);
    await sleep(600);
    await shot('arabic-rtl');
    await ev(`window.sareea.setSettings({theme:'dark'})`);
    await sleep(600);
    await shot('arabic-rtl-dark');
    await ev(`window.sareea.setSettings({language:'en', theme:'light', speedLimitKiBps:0})`);

    process.stdout.write('SHOWCASE DONE\n');
    return 0;
  } catch (e) {
    log.error('showcase failed: ' + (e instanceof Error ? e.message : String(e)));
    try {
      fs.writeFileSync(path.join(env.outDir, '99-failure.png'), (await win.webContents.capturePage()).toPNG());
    } catch {
      /* nothing more to do */
    }
    process.stdout.write('SHOWCASE FAILED\n');
    return 1;
  }
}
