// End-to-end test of the browser integration with a REAL Chrome (or Edge) and the REAL packaged app.
//
//   npm run package:test       (once: builds out-test/ with the TEST flavour of the app and the host)
//   npm run e2e:extension
//
// It uses the TEST flavour (out-test/): the release app and host contain no test hooks, so they cannot be pointed at a
// test data folder or a test pipe. Never run it against a release package.
//
// It never touches your normal browser profile or a running copy of the app:
//   * Chrome starts with a throw-away --user-data-dir in the temp folder and the built extension loaded;
//   * the app keeps its data in a throw-away folder (SAREEA_DL_TEST_DIR) and uses its own pipe name;
//   * the native host is registered under HKCU for the test only, and the keys are removed at the end
//     (the script refuses to start if the Chrome key already exists, and verifies the removal).
// Everything it creates is deleted at the end, and only processes it started itself are killed.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ID, HOST_EXE_NAME, REGISTRY_KEYS } from '../src/app/browser-integration.ts';
import { installIntegration, removeIntegration, systemRegRunner } from '../src/main/browser-integration.ts';
import { makeBuffer, sha256 } from '../test/helpers.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeDir = path.join(root, 'out-test', 'Sareea DL-win32-x64');
const appExe = path.join(exeDir, 'Sareea DL.exe');
const hostExe = path.join(exeDir, HOST_EXE_NAME);
const extDir = path.join(root, 'out-test', 'extension');

// E2E_BROWSER=edge runs the same test with Microsoft Edge instead of Chrome (default).
const CANDIDATES = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'],
};
const wanted = process.env.E2E_BROWSER === 'edge' ? ['edge'] : ['chrome', 'edge'];
const browserKind = wanted.find((k) => CANDIDATES[k].some((p) => fs.existsSync(p)));
const browserExe = browserKind ? CANDIDATES[browserKind].find((p) => fs.existsSync(p)) : undefined;
const REG = systemRegRunner();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};
const metrics = {};

// ------------------------------------------------------------- preconditions

for (const [what, p] of [['app exe', appExe], ['host exe', hostExe], ['built extension', path.join(extDir, 'manifest.json')]]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${what}: ${p}\nrun "npm run package:test" first`);
    process.exit(2);
  }
}
if (!browserExe) {
  console.error('neither Chrome nor Edge was found');
  process.exit(2);
}
const regKey = REGISTRY_KEYS[browserKind];
if ((await REG(['query', regKey])).code === 0) {
  console.error(`${regKey} already exists: refusing to touch a registration that is not ours`);
  process.exit(2);
}

// -------------------------------------------------------------- helpers

function psJson(command) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
  if (!out) return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}
const appPids = () => psJson("Get-CimInstance Win32_Process -Filter \"Name='Sareea DL.exe'\" | Select-Object ProcessId | ConvertTo-Json -Compress").map((p) => p.ProcessId);
function browserPidsFor(profile) {
  const name = path.basename(browserExe);
  const rows = psJson(`Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`);
  return rows.filter((r) => (r.CommandLine ?? '').toLowerCase().includes(profile.toLowerCase())).map((r) => r.ProcessId);
}
function killPid(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* already gone */
  }
}
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
async function waitFor(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// ------------------------------------------------------------ CDP client

async function cdpConnect(wsUrl, onEvent = null) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP connect failed')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method && onEvent) onEvent(m);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const cdpList = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function openTab(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' });
  return r.json();
}

// ------------------------------------------------------------ test site

const KB = 1024;
const FILES = {
  a: { name: 'sareea-e2e-a.zip', seed: 1, size: 3 * 1024 * KB + 17 }, // host not registered: stays in the browser
  b: { name: 'sareea-e2e-b.zip', seed: 2, size: 2 * 1024 * KB + 5 }, // app not running: the host starts it
  c: { name: 'sareea-e2e-c.zip', seed: 3, size: 1024 * KB + 3 }, // app already running
  d: { name: 'sareea-e2e-d.zip', seed: 4, size: 2 * 1024 * KB + 11 }, // granted origin: cookie sent
  e: { name: 'sareea-e2e-e.zip', seed: 5, size: 1536 * KB + 1 }, // same file name on localhost: not granted
  f: { name: 'sareea-e2e-f.zip', seed: 6, size: 1200 * KB }, // while capture is paused
  g: { name: 'sareea-e2e-g.dat', seed: 7, size: 1100 * KB }, // unknown type: captured by size
  h: { name: 'sareea-e2e-h.txt', seed: 8, size: 1300 * KB }, // unlisted type: only captured by size
};
for (const f of Object.values(FILES)) f.buf = makeBuffer(f.size, f.seed);
const SECRET = 'SECRETCOOKIE' + randomBytes(8).toString('hex');
const requests = [];
let sitePort = 0;

function startSite() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rec = {
      t: Date.now(), method: req.method, host: req.headers.host, path: url.pathname, range: req.headers.range ?? null,
      cookie: req.headers.cookie ?? null, browser: req.headers['sec-fetch-mode'] !== undefined,
    };
    requests.push(rec);
    if (url.pathname === '/') {
      const links = Object.entries(FILES).map(([k, f]) => `<a id="${k}" href="/files/${f.name}">${f.name}</a>`).join('\n');
      const other = Object.entries(FILES).map(([k, f]) => `<a id="${k}-localhost" href="http://localhost:${sitePort}/files/${f.name}">${f.name} on localhost</a>`).join('\n');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': [`sess=${SECRET}; Path=/; HttpOnly`, 'pref=dark; Path=/'] });
      res.end(`<!doctype html><title>Sareea DL e2e</title><body>${links}\n${other}</body>`);
      return;
    }
    const name = decodeURIComponent(url.pathname.replace('/files/', ''));
    const entry = Object.values(FILES).find((f) => f.name === name);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    const buf = entry.buf;
    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag: `"e2e-${entry.seed}"`, 'content-disposition': `attachment; filename="${entry.name}"` };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      const start = m[1] === '' ? buf.length - Number(m[2]) : Number(m[1]);
      const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return void res.end();
      res.end(buf.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': buf.length });
    if (req.method === 'HEAD') return void res.end();
    res.end(buf);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ----------------------------------------------------------------- browser

async function launchBrowser({ profile, extension, headless }) {
  const port = await freePort();
  const prefs = {
    download: { default_directory: chromeDl, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: chromeDl },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
    safebrowsing: { enabled: false },
  };
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify(prefs));
  // How the extension gets loaded:
  //  * Chrome 137+ ignores --load-extension in branded builds, so for Chrome it is loaded the supported way:
  //    CDP "Extensions.loadUnpacked" over --remote-debugging-pipe (needs --enable-unsafe-extension-debugging).
  //    The pipe must stay open for the whole run: Chrome quits when it closes.
  //  * Edge (155) still honours --load-extension, and its launcher process hands over to another process,
  //    so the pipe cannot be inherited: it uses the flag.
  const usePipe = browserKind === 'chrome';
  const args = [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check',
    '--disable-default-apps', '--disable-sync',
    ...(usePipe ? ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging'] : [`--load-extension=${extension}`]),
    ...(headless ? ['--headless=new'] : []), 'about:blank',
  ];
  const child = spawn(browserExe, args, { stdio: usePipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore', windowsHide: false, env: { ...process.env, SAREEA_DL_TEST_DIR: appDir } });
  let pipeSend = null;
  if (usePipe) {
    const [toBrowser, fromBrowser] = [child.stdio[3], child.stdio[4]];
    let inbuf = Buffer.alloc(0);
    const waiting = new Map();
    fromBrowser.on('data', (d) => {
      inbuf = Buffer.concat([inbuf, d]);
      let i;
      while ((i = inbuf.indexOf(0)) >= 0) {
        const m = JSON.parse(inbuf.subarray(0, i).toString());
        inbuf = inbuf.subarray(i + 1);
        if (m.id && waiting.has(m.id)) waiting.get(m.id)(m);
      }
    });
    let pipeId = 0;
    pipeSend = (method, params) => new Promise((resolve) => {
      const id = ++pipeId;
      waiting.set(id, resolve);
      toBrowser.write(JSON.stringify({ id, method, params }) + String.fromCharCode(0));
    });
  } else {
    child.unref();
  }
  const up = await waitFor(async () => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null), 30_000);
  if (!up) throw new Error('the browser did not open its debugging port');
  let extensionId;
  if (usePipe) {
    const loaded = await Promise.race([pipeSend('Extensions.loadUnpacked', { path: extension }), sleep(20_000).then(() => ({ error: { message: 'timeout' } }))]);
    if (loaded.error) throw new Error('Extensions.loadUnpacked failed: ' + loaded.error.message);
    extensionId = loaded.result.id;
  } else {
    const sw = await waitFor(async () => (await cdpList(port)).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`)), 20_000);
    extensionId = sw ? new URL(sw.url).host : null;
  }
  return { port, pid: child.pid, version: up.Browser, profile, extensionId };
}

async function stopBrowser(b) {
  if (!b) return;
  for (let i = 0; i < 3; i++) {
    for (const pid of browserPidsFor(b.profile)) killPid(pid);
    if (browserPidsFor(b.profile).length === 0) break;
    await sleep(500);
  }
}

// ----------------------------------------------------------- the scenarios

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sareea-e2e-'));
const appDir = path.join(base, 'app');
const chromeDl = path.join(base, 'browser-downloads');
const hostData = path.join(base, 'host-data');
const appDownloads = path.join(appDir, 'downloads');
for (const d of [appDir, chromeDl, hostData, appDownloads]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(appDir, 'settings.json'), JSON.stringify({ defaultDir: appDownloads, categorySubfolders: false, browserAutoStart: true, notifyOnComplete: false, closeToTray: false }));

const appBefore = new Set(appPids());
const startedBrowsers = [];
const allProfiles = [];
const realProfileDir = path.join(process.env.APPDATA ?? '', 'Sareea DL');
const realProfileExisted = fs.existsSync(realProfileDir);
let site;
let registered = false;
let failure = null;

// Errors and warnings logged by the extension's pages and service worker during the run.
const loggedProblems = [];
function noteLogEvent(m) {
  const p = m.params;
  if (m.method === 'Runtime.exceptionThrown') loggedProblems.push('exception: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
  else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) loggedProblems.push(p.type + ': ' + p.args.map((a) => a.value ?? a.description).join(' '));
  else if (m.method === 'Log.entryAdded' && (p.entry.level === 'error' || p.entry.level === 'warning')) loggedProblems.push(p.entry.level + ': ' + p.entry.text);
}

async function popupSession(b) {
  const tab = await openTab(b.port, `chrome-extension://${EXTENSION_ID}/popup.html`);
  const cdp = await cdpConnect(tab.webSocketDebuggerUrl, noteLogEvent);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await waitFor(() => cdp.evaluate('!!(document.body && document.body.dataset.ready === "1")').catch(() => false), 10_000, 50);
  return { cdp, tab };
}
const extEval = (cdp, expr) => cdp.evaluate(expr);

async function clickDownload(b, linkId) {
  const tab = (await cdpList(b.port)).find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  const cdp = await cdpConnect(tab.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/` });
  await waitFor(async () => (await cdp.evaluate('document.readyState')) === 'complete' && (await cdp.evaluate('!!document.getElementById("a")')), 10_000, 100);
  const t0 = Date.now();
  await cdp.evaluate(`document.getElementById(${JSON.stringify(linkId)}).click()`);
  cdp.close();
  return t0;
}

const downloadsOf = async (popup) => extEval(popup.cdp, 'chrome.downloads.search({}).then(r => r.map(d => ({ id: d.id, state: d.state, url: d.url, filename: d.filename, danger: d.danger })))');
const badgeOf = async (popup) => extEval(popup.cdp, 'Promise.all([chrome.action.getBadgeText({}), chrome.action.getTitle({})]).then(([t, title]) => ({ text: t, title }))');

function sareeaFile(name) {
  const p = path.join(appDownloads, name);
  return fs.existsSync(p) ? p : null;
}
async function waitForSareeaFile(name, ms = 60_000) {
  return waitFor(async () => {
    const p = sareeaFile(name);
    if (!p) return null;
    // finished = the final name exists and no .part/.sareea.json is left next to it
    return fs.existsSync(p + '.part') || fs.existsSync(p.replace(/\.[^.]+$/, '') + '.sareea.json') || fs.existsSync(p + '.sareea.json') ? null : p;
  }, ms, 150);
}
const browserFilesFor = (name) => fs.readdirSync(chromeDl).filter((f) => f.startsWith(name.replace(/\.[^.]+$/, '')));
const siteRequestsFor = (name) => requests.filter((r) => r.path.endsWith('/' + name));

async function scenarioHostMissing(b) {
  console.log('\n--- 1. host not registered: the browser must keep its own download');
  const popup = await popupSession(b);
  const t0 = await clickDownload(b, 'a');
  const got = await waitFor(() => browserFilesFor(FILES.a.name).find((f) => !f.endsWith('.crdownload')), 30_000);
  check('1. download carries on in the browser when the host is missing', got, got ? `${Date.now() - t0} ms` : 'no file');
  if (got) check('1. the browser file is byte-exact', sha256(fs.readFileSync(path.join(chromeDl, got))) === sha256(FILES.a.buf));
  const badge = await badgeOf(popup);
  check('1. badge says the integration is missing', badge.text === '!' && /not installed/i.test(badge.title), JSON.stringify(badge));
  const st = await extEval(popup.cdp, 'new Promise(r => chrome.runtime.sendNativeMessage("com.sareea.dl", {type:"ping"}, (x) => r({ x: x ?? null, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })))');
  check('1. Chrome reports the host as not found', /not found/i.test(st.err ?? ''), st.err);
  check('1. the app was not started', appPids().filter((p) => !appBefore.has(p)).length === 0);
  popup.cdp.close();
}

async function scenarioCapture(b, { id, appRunning, expectCookie, host = '127.0.0.1' }) {
  const f = FILES[id];
  console.log(`\n--- capture ${f.name} (app ${appRunning ? 'running' : 'NOT running'}, cookie ${expectCookie ? 'granted' : 'not granted'}, site ${host})`);
  const popup = await popupSession(b);
  const t0 = await clickDownload(b, host === '127.0.0.1' ? id : `${id}-localhost`);
  const done = await waitForSareeaFile(f.name);
  const ms = Date.now() - t0;
  check(`${f.name}: Sareea DL downloaded the file`, done, done ? `${ms} ms from click to finished file` : 'timeout');
  if (done) check(`${f.name}: byte-exact (sha256 and size)`, sha256(fs.readFileSync(done)) === sha256(f.buf) && fs.statSync(done).size === f.buf.length, `${f.buf.length} bytes`);
  await sleep(500);
  const dls = await downloadsOf(popup);
  check(`${f.name}: the browser's own download was cancelled and erased`, dls.filter((d) => d.url.includes(f.name)).length === 0, `${dls.length} other item(s) in the browser's list`);
  check(`${f.name}: nothing was written to the browser's download folder`, browserFilesFor(f.name).length === 0, browserFilesFor(f.name).join(','));
  const mine = siteRequestsFor(f.name);
  const fromBrowser = mine.filter((r) => r.browser);
  const fromApp = mine.filter((r) => !r.browser);
  check(`${f.name}: the browser itself asked for it (that is what we intercept)`, fromBrowser.length >= 1, `${fromBrowser.length} browser request(s)`);
  check(`${f.name}: the app downloaded it with ${fromApp.length} request(s)`, fromApp.length >= 1);
  const browserSentCookie = fromBrowser.some((r) => (r.cookie ?? '').includes(SECRET));
  if (expectCookie) {
    check(`${f.name}: the granted origin's cookie (incl. HttpOnly) reached the app's request`, fromApp.length > 0 && fromApp.every((r) => (r.cookie ?? '').includes('sess=' + SECRET) && (r.cookie ?? '').includes('pref=dark')), JSON.stringify(fromApp.map((r) => r.cookie ? 'cookie sent' : 'no cookie')));
  } else {
    check(`${f.name}: NO cookie was sent by the app (origin not granted)`, fromApp.length > 0 && fromApp.every((r) => r.cookie === null), JSON.stringify(fromApp.map((r) => r.cookie ? 'COOKIE SENT' : 'no cookie')));
    if (host === '127.0.0.1') check(`${f.name}: ...although the browser's own request did carry the cookie (so it was available to leak)`, browserSentCookie);
  }
  popup.cdp.close();
  return ms;
}

try {
  site = await startSite();
  sitePort = site.address().port;
  console.log(`browser: ${browserExe}\ntemp: ${base}\ntest site: http://127.0.0.1:${sitePort}/`);

  // ============================= shipping extension, headless browser ===============================
  const profile1 = path.join(base, 'profile-1');
  let b = await launchBrowser({ profile: profile1, extension: extDir, headless: true });
  startedBrowsers.push(b);
  allProfiles.push(b.profile);
  metrics.browser = b.version;
  const swTarget = await waitFor(async () => (await cdpList(b.port)).find((t) => t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`)), 15_000);
  check('the extension loaded in the temporary browser with the expected stable ID', swTarget && b.extensionId === EXTENSION_ID, `${b.extensionId} ${swTarget ? swTarget.url : 'no extension target'}`);
  if (!swTarget) throw new Error('extension did not load');
  const swCdp = await cdpConnect(swTarget.webSocketDebuggerUrl, noteLogEvent).catch(() => null);
  await swCdp?.send('Runtime.enable');
  await swCdp?.send('Log.enable');

  let popup = await popupSession(b);
  const manifest = await extEval(popup.cdp, 'chrome.runtime.getManifest()');
  check('installed manifest has no content scripts and no static host permissions', !manifest.content_scripts && !manifest.host_permissions, '');
  const perms = await extEval(popup.cdp, 'chrome.permissions.getAll()');
  check('no site is granted by default', (perms.origins ?? []).length === 0, JSON.stringify(perms.origins));
  check('only the five declared permissions are held', JSON.stringify([...perms.permissions].sort()) === JSON.stringify(['contextMenus', 'cookies', 'downloads', 'nativeMessaging', 'storage']), JSON.stringify(perms.permissions));
  popup.cdp.close();

  await scenarioHostMissing(b);

  // register the host (Chrome key only, for this test)
  const inst = await installIntegration({ exePath: hostExe, dataDir: hostData, run: REG, browsers: [browserKind] });
  registered = inst.ok;
  check(`host registered under ${regKey}`, inst.ok, inst.ok ? '' : inst.error);
  const q = await REG(['query', regKey, '/ve']);
  check('registry value points at the manifest in the temp folder', q.stdout.includes(hostData), '');

  console.log('\n--- popup status with the app not running');
  popup = await popupSession(b);
  await waitFor(async () => !/Checking/.test(await extEval(popup.cdp, 'document.getElementById("statusText").textContent')), 8000);
  let status = await extEval(popup.cdp, 'document.getElementById("statusText").textContent');
  check('popup says Sareea DL is not running', /not running/i.test(status), status);
  popup.cdp.close();

  const msCold = await scenarioCapture(b, { id: 'b', appRunning: false, expectCookie: false });
  metrics.coldStartClickToFinishedMs = msCold;
  const appNow = appPids().filter((p) => !appBefore.has(p));
  check('the app the host started is still running after the host exited (detached)', appNow.length >= 1, `pids ${appNow.join(',')}`);

  popup = await popupSession(b);
  const badge2 = await badgeOf(popup);
  check('badge was cleared after a successful hand-over', badge2.text === '', JSON.stringify(badge2));
  await waitFor(async () => /is running/i.test(await extEval(popup.cdp, 'document.getElementById("statusText").textContent')), 8000);
  status = await extEval(popup.cdp, 'document.getElementById("statusText").textContent');
  check('popup says Sareea DL is running', /is running/i.test(status), status);
  if (process.env.E2E_SHOTS) {
    // optional: E2E_SHOTS=<folder> saves a picture of the popup
    await extEval(popup.cdp, 'document.querySelector("details").open = true');
    await new Promise((r) => setTimeout(r, 500));
    const shot = await popup.cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 380, height: 760, scale: 2 } });
    fs.mkdirSync(process.env.E2E_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.E2E_SHOTS, 'popup.png'), Buffer.from(shot.data, 'base64'));
  }
  const lat = [];
  for (let i = 0; i < 6; i++) lat.push(await extEval(popup.cdp, 'new Promise(r => { const t = performance.now(); chrome.runtime.sendNativeMessage("com.sareea.dl", {type:"ping"}, () => r(Math.round(performance.now() - t))); })'));
  lat.shift();
  lat.sort((x, y) => x - y);
  metrics.hostPingRoundTripMs = { median: lat[Math.floor(lat.length / 2)], min: lat[0], max: lat[lat.length - 1] };
  check('host ping round trip from the browser is fast', metrics.hostPingRoundTripMs.median < 1500, JSON.stringify(metrics.hostPingRoundTripMs));
  popup.cdp.close();

  const msWarm = await scenarioCapture(b, { id: 'c', appRunning: true, expectCookie: false });
  metrics.runningAppClickToFinishedMs = msWarm;

  console.log('\n--- capture by size (unknown file type, at least 1 MB)');
  await scenarioCapture(b, { id: 'g', appRunning: true, expectCookie: false });

  console.log('\n--- a small download of an unlisted type stays in the browser');
  {
    // sareea-e2e-h.txt is 1.3 MB: first make the size rule not apply by raising the minimum to 5 MB through the popup
    popup = await popupSession(b);
    await extEval(popup.cdp, 'chrome.storage.local.set({ settings: { enabled: true, extensions: ["zip"], minSizeMB: 5, pausedUntil: 0, askCookiesOnMenu: true, declinedOrigins: [] } })');
    await sleep(300);
    await clickDownload(b, 'h');
    const got = await waitFor(() => browserFilesFor(FILES.h.name).find((f) => !f.endsWith('.crdownload')), 30_000);
    check('an unlisted type below the size limit is left to the browser', got && !sareeaFile(FILES.h.name), got ?? 'no file');
    await extEval(popup.cdp, 'chrome.storage.local.remove("settings")');
    popup.cdp.close();
  }

  console.log('\n--- pause capture (popup button) keeps downloads in the browser');
  {
    popup = await popupSession(b);
    await extEval(popup.cdp, 'document.getElementById("pause").click()');
    await sleep(500);
    const pausedUntil = await extEval(popup.cdp, 'chrome.storage.local.get("settings").then(r => r.settings.pausedUntil)');
    check('pause sets a deadline about 5 minutes ahead', pausedUntil - Date.now() > 4 * 60_000 && pausedUntil - Date.now() <= 5 * 60_000 + 2000, `${Math.round((pausedUntil - Date.now()) / 1000)} s`);
    await clickDownload(b, 'f');
    const got = await waitFor(() => browserFilesFor(FILES.f.name).find((f) => !f.endsWith('.crdownload')), 30_000);
    check('while paused the download stays in the browser', got && !sareeaFile(FILES.f.name), got ?? 'no file');
    await extEval(popup.cdp, 'document.getElementById("pause").click()'); // resume
    await sleep(300);
    const after = await extEval(popup.cdp, 'chrome.storage.local.get("settings").then(r => r.settings.pausedUntil)');
    check('the same button resumes capture', after === 0, String(after));
    popup.cdp.close();
  }

  check('no error or warning was logged by the service worker or the popup', loggedProblems.length === 0, loggedProblems.join(' | '));

  // Stop the browser first so its storage files are unlocked, then look for the cookie value on disk.
  await stopBrowser(b);
  startedBrowsers.pop();
  console.log('\n--- no cookie or secret was stored by the extension');
  const storeDirs = ['Local Extension Settings', 'Sync Extension Settings', 'Extension State', 'Extension Rules', 'Session Storage', 'Local Storage', 'IndexedDB', 'Service Worker'].map((d) => path.join(profile1, 'Default', d));
  const leaked = [];
  let scanned = 0;
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else {
        scanned++;
        if (fs.readFileSync(p).includes(SECRET)) leaked.push(p);
      }
    }
  };
  for (const d of storeDirs) scan(d);
  check("the cookie value is not in the extension's storage (profile folders scanned)", leaked.length === 0, `${scanned} files scanned ${leaked.join(';')}`);

  // ===== variant with 127.0.0.1 granted (static host permission only in this test copy, same key and ID) =====
  console.log('\n=== second run: test copy of the extension with host access to http://127.0.0.1/* only ===');
  const extB = path.join(base, 'ext-with-grant');
  fs.cpSync(extDir, extB, { recursive: true });
  const mb = JSON.parse(fs.readFileSync(path.join(extB, 'manifest.json'), 'utf8'));
  mb.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(extB, 'manifest.json'), JSON.stringify(mb, null, 2));
  b = await launchBrowser({ profile: path.join(base, 'profile-2'), extension: extB, headless: true });
  startedBrowsers.push(b);
  allProfiles.push(b.profile);
  const sw2 = await waitFor(async () => (await cdpList(b.port)).find((t) => t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`)), 15_000);
  check('test copy loaded with the same extension ID', sw2 && b.extensionId === EXTENSION_ID, b.extensionId);
  if (sw2) {
    popup = await popupSession(b);
    const p2 = await extEval(popup.cdp, 'chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] })');
    const p3 = await extEval(popup.cdp, 'chrome.permissions.contains({ origins: ["http://localhost/*"] })');
    check('127.0.0.1 is granted in the test copy and localhost is not', p2 === true && p3 === false, `${p2}/${p3}`);
    popup.cdp.close();
    await scenarioCapture(b, { id: 'd', appRunning: true, expectCookie: true });
    await scenarioCapture(b, { id: 'e', appRunning: true, expectCookie: false, host: 'localhost' });
  }
  await stopBrowser(b);
  startedBrowsers.pop();

  // The app must not have stored the cookie either. Quit it the normal way first (WM_CLOSE, so it saves its
  // queue and settings like a real exit), then read its data folder.
  const mineNow = () => appPids().filter((p) => !appBefore.has(p));
  for (const pid of mineNow()) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* helper processes have no window: they end with the main one */
    }
  }
  const quit = await waitFor(() => mineNow().length === 0, 20_000, 250);
  check('the app quit normally when asked (saved its state)', quit);
  const leakedApp = [];
  let scannedApp = 0;
  const scanApp = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === appDownloads) continue; // downloaded payload bytes are random data
        scanApp(p);
        continue;
      }
      try {
        if (fs.statSync(p).size < 50 * 1024 * 1024) {
          scannedApp++;
          if (fs.readFileSync(p).includes(SECRET)) leakedApp.push(p);
        }
      } catch {
        /* a file still locked by a helper process: skipped */
      }
    }
  };
  scanApp(appDir);
  check("the cookie value is not in the app's data folder (queue, settings, logs)", leakedApp.length === 0, `${scannedApp} files scanned ${leakedApp.join(';')}`);
  check('the real app profile was not created or touched', realProfileExisted || !fs.existsSync(realProfileDir), realProfileDir);
} catch (e) {
  failure = e;
  console.error('\nE2E ERROR:', e?.stack ?? e);
} finally {
  console.log('\n--- cleanup');
  for (const b of startedBrowsers) await stopBrowser(b);
  const leftBrowser = allProfiles.flatMap((p) => browserPidsFor(p));
  for (const pid of appPids().filter((p) => !appBefore.has(p))) killPid(pid);
  await sleep(500);
  if (site) site.close();
  if (registered || (await REG(['query', regKey])).code === 0) {
    const r = await removeIntegration({ dataDir: hostData, run: REG, browsers: [browserKind] });
    if (!r.ok) console.error('registry cleanup error:', r.error);
  }
  const gone = (await REG(['query', regKey])).code !== 0;
  const otherKind = browserKind === 'chrome' ? 'edge' : 'chrome';
  const otherKey = (await REG(['query', REGISTRY_KEYS[otherKind]])).code !== 0;
  check(`registry key ${regKey} removed and verified gone`, gone);
  check(`the ${otherKind} key was never created`, otherKey);
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(base, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
  check('temporary profile and files deleted', !fs.existsSync(base), base);
  check('no browser process of the temporary profiles is left', leftBrowser.length === 0, leftBrowser.join(','));
  check('no new Sareea DL process is left', appPids().filter((p) => !appBefore.has(p)).length === 0);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log('metrics:', JSON.stringify(metrics));
  if (failure || failed.length) process.exitCode = 1;
}
