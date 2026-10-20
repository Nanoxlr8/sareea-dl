# Sareea DL

A fast, resumable, multi-connection download manager for Windows, written from scratch in TypeScript.
It has a download engine, a command line tool, and (phase 2) an Electron desktop app in the style of
IDM: download list, categories, per-connection progress blocks, tray, queue, English and Arabic UI.
Phase 3 adds a Chrome and Edge extension (Manifest V3, no content scripts, no site access unless you grant it
one site at a time) and the native-messaging host that hands browser downloads to the app over its local pipe.

* The engine has zero runtime dependencies (Node built-ins only). The desktop app adds Electron, and
  its dev tools are `electron`, `esbuild` and `@electron/packager`, nothing else. The extension and the
  native host add no dependency at all.
* Original code. Nothing here is copied from IDM or any other download manager.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Engine, CLI, tests | Done |
| 2 | Electron desktop app: list, categories, add dialog, detail panel, settings, tray, notifications, queue, English/Arabic (RTL), clipboard watch, local bridge, packaging | Done |
| 3 | Chrome/Edge MV3 extension, native-messaging host and registration buttons in Settings ([docs/extension.md](docs/extension.md), bridge: [docs/protocol.md](docs/protocol.md)) | Done (this version) |

## Requirements

Windows 10/11 x64, Node 24 or newer and npm (developed on Node v24.14.1, npm 11). The engine, CLI and
tests run straight from the TypeScript sources with Node's type stripping. The app is bundled with
esbuild, so Electron does not need to strip types. Building (not running) the native-messaging host needs
`csc.exe`, the C# compiler that is part of the .NET Framework 4 on every Windows 10/11 PC.

## Run

```
npm install                    # once: electron, esbuild, @electron/packager
npm test                       # 248 tests (engine, app logic, bridge, extension logic, native host), about 9 seconds
npm start                      # build, then open the desktop app
npm start -- --self-test       # build, then prove an end-to-end download through the app and quit
npm run build                  # esbuild -> dist/ (main.cjs, preload.cjs, renderer/, extension/, host/)
npm run package                # build + package -> out/Sareea DL-win32-x64/ (app + sareea-dl-host.exe),
                               #   out/extension and out/sareea-dl-extension.zip
npm run e2e:extension          # real Chrome (E2E_BROWSER=edge for Edge) + packaged app, throw-away profile
npm run dl -- <url> [options]  # the phase-1 command line tool
npm run icon                   # redraw assets/icon.png and icon.ico (already committed)
```

Note: npm 11 may skip Electron's download script during `npm install` (it warns about install scripts).
If `node_modules/electron/dist` is missing, run `node node_modules/electron/install.js` once. Run the npm
scripts from a normal path: they call `node scripts/*.mjs` directly because a `&` in the folder name
breaks `.bin` shims under cmd.exe.

Packaged app: `out/Sareea DL-win32-x64/Sareea DL.exe` (asar on, app icon, hardened fuses, see Security), with
`sareea-dl-host.exe` next to it and the extension in `resources/extension`. `out/` and `dist/` are not committed.

### Browser extension (phase 3)

Settings has **Install browser integration** and **Remove browser integration** (off by default, nothing registers
itself). Install, then load `out/extension` (or the folder the Settings button opens) in Chrome or Edge with
Developer mode, Load unpacked. Capture rules, the permission table and why each permission is needed, how cookies
are handled, how the host works, test results and limits: [docs/extension.md](docs/extension.md).

### `--self-test`

`Sareea DL.exe --self-test` (or `npm start -- --self-test`) runs in a throw-away profile in the temp
folder and uses the real window. It checks that the page has no Node access and no CSP errors, that
hostile IPC calls are refused, that the bridge pipe answers and rejects bad input, then a bridge
"add" opens the prefilled Add dialog, "Start now" downloads
`https://proof.ovh.net/files/10Mb.dat` (10 485 760 bytes), the list shows it as completed, and the UI
flips to Arabic RTL. It prints `SELF-TEST PASS` or `FAIL` plus a JSON report and exits 0 or 1.
Options: `--self-test-out=<file>` (also write the JSON there), `--screenshot-dir=<dir>` (save PNGs and show the window).
It needs internet access.

## The desktop app

* **Main window.** Toolbar (Add URL, Resume, Pause, Delete, Delete with file, Start queue, Stop queue,
  Details, Settings), category sidebar (All, Compressed, Documents, Music, Programs, Video, Unfinished,
  Finished; by file extension), sortable table (name, size, progress bar, %, speed, time left, status,
  added), multi-select (click, Ctrl, Shift, Ctrl+A), right-click menu (Open, Open folder, Copy link,
  Pause, Resume, Redownload, Details, Delete, Delete with file), drag a link onto the window to add it.
  Keys: `Ctrl+V` add from clipboard, `Del` delete (`Shift+Del` with file), `Enter` open or details.
* **Add dialog.** Reads an http(s) link from the clipboard if there is one, probes it (name, size,
  resume support), folder (default or Browse), connections 1 to 16, Start now or Add to queue.
  "Add to queue" keeps the item paused (status Queued) until Start queue.
* **Detail panel.** One coloured block per slice of the file, filled as bytes arrive, with the current
  connections visible as the engine splits work (IDM style), a bar per connection, a speed graph, and
  transfer details (size, done, speed, time left, save path, link, notes from the engine).
* **Settings.** Default folder (default `%USERPROFILE%\Downloads\Sareea`), per-category subfolders,
  simultaneous downloads (1 to 10), default connections (1 to 16), global speed limit (KB/s),
  start with Windows (off), theme (system, light, dark), language (English, Arabic with RTL layout),
  close to tray, completion notifications, clipboard watch (off), start browser downloads without asking
  (off). Changes apply at once.
* **Tray.** Menu: Show, Pause all, Resume all, Quit. Closing the window hides it to the tray (setting).
  Quit pauses everything cleanly and saves first. A second launch just shows the running window.
* **Notifications.** A Windows notification when a download completes (click: open its folder), and,
  with clipboard watch on, when a link to a downloadable file type is copied (click: open the Add dialog).
* **Persistence.** `%APPDATA%\Sareea DL\` holds `queue.json` (the phase-1 Queue file: the list and
  history), `settings.json`, `meta.json` (which items are "Queued"), and `logs\`. Downloads that were
  running when the app stopped come back **paused**; Resume continues from the saved segments.
* **Mark of the Web.** Finished files get a `Zone.Identifier` stream (zone 3, link origin and path),
  so SmartScreen and Office treat them as downloaded from the internet.

## Local bridge for the browser extension

The app listens on `\\.\pipe\sareea-dl-<username>`: newline-delimited JSON, request
`{v:1, id, type:"add"|"ping", url, fileName?, referrer?, headers?{cookie?, userAgent?}, pageUrl?}`,
reply `{v:1, id, ok, error?}`. An "add" opens the Add dialog prefilled for the user to confirm, unless
"Start browser downloads without asking" is on. Cookies stay in memory for that one download.
The browser reaches it through the native-messaging host `sareea-dl-host.exe`
([docs/extension.md](docs/extension.md)). Full description, limits and examples: [docs/protocol.md](docs/protocol.md).

## Security model

The goal: a page that is only ever our own local file, no network from the UI, a very small and
validated surface between the page and the system, and no secrets on disk.

**Window and renderer**

* `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, no webviews,
  no remote module, DevTools disabled in the packaged app, no application menu, spellcheck off.
* The only page is `dist/renderer/index.html` (inside `app.asar` when packaged), loaded with `loadFile`.
  Strict CSP in the page: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. No inline script or style
  attributes; text from the engine or network is only ever set with `textContent`.
* `will-navigate`, `will-redirect` and `will-attach-webview` are blocked; `setWindowOpenHandler` denies
  every window and opens only validated `http(s)` links through `shell.openExternal`.
* Permission requests are denied. Any request from the UI to `http(s)`, `ws(s)` or `ftp` is cancelled
  and logged: the engine downloads from the Node side, the UI never touches the network.
* The preload script exposes one frozen object, `window.sareea`, with one method per action
  (`src/app/api.ts`). No generic IPC access.

**IPC**

* Every `ipcMain.handle` checks the sender: it must be the main window's top frame and its URL must be
  our own `index.html` (`isTrustedSender`). Anything else is refused and logged.
* Every argument is validated for type, exact shape and range before it is used (`src/app/ipc.ts`,
  `src/app/settings.ts`): only `http(s)` links, connections 1 to 16, ids must be UUIDs, unknown fields
  are rejected.
* Open file and Open folder take only a download id and look the path up in the app's own list, for
  finished files the app downloaded itself. The renderer can never name a path to open.
* A download folder from the renderer is accepted only inside the default folder or one the user chose
  in the native folder dialog in this session. The default folder can only be changed to such a folder.
* The app never runs a download by itself. Opening a program or script (exe, msi, bat, ps1, js, lnk, jar,
  iso, macro documents and so on) first asks for confirmation in a native dialog.

**Data and privacy**

* No telemetry, no update checks, no crash reporting, no network except the downloads you start (and
  the link probe the Add dialog does for a link you typed).
* Cookie, Authorization and other header values are never written to disk and never logged. The queue
  file records only that headers existed and their names. Logs (`%APPDATA%\Sareea DL\logs`, 14 days) pass
  through a redactor that drops query strings, credentials in URLs, cookie and authorization values.
* Browser cookies from the bridge live in memory under a single-use random token for 10 minutes. The
  window never sees the value.
* Single-instance lock. Start with Windows is off by default and is applied only by the packaged app.

**Bridge pipe**

* Name includes the user name. Node creates the pipe with the default Windows ACL, which also lets
  Everyone and Anonymous read; right after listening the app removes those two entries (a short fixed
  PowerShell script run from `%SystemRoot%\System32`), leaving the user, Administrators and SYSTEM.
  Even before that, nobody else could write to it.
* Strict validation, size limits on every field, 64 KiB per line, 8 connections, 50 requests per
  connection, 15 s idle timeout. With "start without asking" off (the default) a request can only open a
  prefilled dialog; the user decides.

**Browser extension and native host** (details and the permission table: [docs/extension.md](docs/extension.md))

* No content scripts, no static host permissions, no `tabs`/`activeTab`/`webRequest`/`scripting`. Permissions:
  `downloads`, `nativeMessaging`, `contextMenus`, `storage`, `cookies`, plus optional http(s) host access that
  is requested for **one origin at a time**, only inside a click, and shown with a Revoke button in the popup.
* `cookies.getAll` is called only for the exact download URL and only when that origin was granted. The cookie
  goes to the host for that one download, then lives in the app's memory for 10 minutes; it is never stored,
  logged, or put in an error message (verified end to end by searching the extension's and the app's data).
* Strict extension CSP (`script-src 'self'; object-src 'none'`, plus `connect-src 'none'`), no remote code, no
  `eval`, no network request of its own. Stable extension ID from a public key in the manifest; the private key
  is not in the repository (`secrets/`, gitignored).
* The host manifest's `allowed_origins` lists only that ID, and the host checks its origin argument itself. The
  host logs nothing, writes nothing to disk, and a captured download is cancelled in the browser only after the
  app has accepted it. Nothing registers itself: the registry keys (HKCU only) are written by the Settings button.

**Packaged executable (fuses)**

`npm run package` flips Electron fuses in the exe: `RunAsNode` off, `NODE_OPTIONS` ignored, Node CLI
inspect arguments off, cookie encryption on, embedded ASAR integrity validation on, only load the app
from `app.asar`, WebAssembly trap handlers on. `GrantFileProtocolExtraPrivileges` has to stay on,
because with it off Electron cannot load a page from inside `app.asar` (tested: `ERR_FILE_NOT_FOUND`);
the CSP, the navigation block and the sender check above are what contain a `file://` page. A packaged
app also refuses `--inspect`, `--debug` and `--remote-debugging-*` switches. The app is not code-signed.

## Using the engine (phase 1)

```
node src/cli.ts <url> [-o dir] [-c 8] [--limit 2M] [-n name] [-H "Name: value"] [--sha256 hex]
```

| Option | Meaning |
|---|---|
| `-o, --out <dir>` | Output folder (default: current folder) |
| `-c, --connections <n>` | Parallel connections, 1 to 32 (default 8) |
| `--limit <rate>` | Speed cap: `500K`, `2M`, `1.5G` (bytes per second, binary units) |
| `-n, --name <file>` | Save under this name instead of the server's |
| `-H, --header <h>` | Extra request header, repeatable (cookies, referrer, user agent). Values are never printed or saved |
| `--sha256 <hex>` | Fail unless the finished file has this hash |

The CLI shows one live line: percent, MB/s, ETA, bytes. **Ctrl+C pauses cleanly** (the progress file is
saved); run the same command again and it resumes. Press Ctrl+C twice to quit immediately.
Exit codes: 0 done, 130 paused, 1 failed, 2 bad arguments.

```ts
import { Download, Limiter, Queue } from './src/index.ts';

const limiter = new Limiter(2 * 1024 * 1024);          // shared cap, change any time: limiter.setLimit(0)
const d = new Download({ url, dir: 'C:/dl', connections: 8, limiter,
                         headers: { Cookie: '...', Referer: '...' } });
d.on('progress', (p) => console.log(p.downloaded, p.size, p.speed, p.eta, p.segments));
d.on('warning', (w) => console.warn(w.code, w.message));
d.on('done',    (r) => console.log(r.path, r.sha256));
d.on('error',   (e) => console.error(e.message));
const finalState = await d.start();   // 'done' | 'paused' | 'error' | 'cancelled' (never rejects)
await d.pause();                      // later: d.start() resumes
await d.cancel(true);                 // true = delete the .part and sidecar
```

Download events: `state`, `progress` (about every 250 ms), `warning` `{code,message}`, `done` `{path,sha256,size}`,
`error` (only emitted if you listen, so it can never crash the process).
Warning codes: `single-connection`, `ranges-ignored`, `remote-changed`, `not-resumable`, `part-invalid`.

```ts
const q = new Queue({ persistPath: 'queue.json', maxConcurrent: 3, limitBytesPerSec: 0 });
const id = q.add({ url, dir });                       // starts when a slot is free
const held = q.add({ url, dir }, { paused: true });   // added but not started (phase 2)
q.on('progress', ({ id, downloaded, size, speed }) => {});
await q.pause(id); q.resume(id); await q.cancel(id, true); q.setLimit(1_000_000); q.list();
```

Queue events carry the id: `added`, `removed`, `state`, `settled`, `progress`, `done`, `warning`, `error`.
Phase 2 added to the engine: `Download.fileName` (name once probed), `QueueItem.name`, and the
`{ paused: true }` flag on `Queue.add`. Nothing else in the engine changed.

## Architecture

```
src/
  index.ts      engine public API
  download.ts   Download class: the engine (probe, segments, workers, retry, sidecar, verify, rename)
  probe.ts      HEAD, falls back to GET "Range: bytes=0-0"; size, ranges, ETag, Last-Modified, name, MIME
  segments.ts   pure logic: initial split, work stealing (split the largest remainder in half), validation
  throttle.ts   shared token-bucket Limiter, changeable at runtime
  queue.ts      Queue: concurrency cap, global limiter, pause/resume/cancel by id, JSON persistence
  filename.ts   Windows-safe names, Content-Disposition (incl. filename*=UTF-8''), uniqueName
  http.ts       thin node:http(s) client: redirects, no auto-decompression, error classes
  format.ts     size parsing and formatting for the CLI
  cli.ts        command line front end
  app/          pure app logic shared by main, preload and renderer (no Electron), all unit tested
    api.ts        view types, the window.sareea API type, IPC channel names
    ipc.ts        validators for every renderer request, sender check, folder rules
    settings.ts   settings model, defaults, strict patch and lenient load validation
    categories.ts extension -> category, sidebar filters, risky file types, link detection
    protocol.ts   bridge protocol parsing, limits, reply format, line splitter
    strings.ts    every UI string in English and Arabic
    fmt.ts        size, speed, time and date formatting (Arabic units, Western digits)
    redact.ts     secret stripping for logs
    browser-integration.ts  host name, extension ID, host manifest, registry keys (shared with the host build)
    nativemsg.ts  native messaging framing (4-byte length + JSON) as the browser sees it
  main/         Electron main process
    browser-integration.ts  install/remove the host registration (manifest file + HKCU values via reg.exe)
    main.ts       window, tray, IPC wiring, session hardening, notifications, clipboard watch
    controller.ts the app's brain: queue, settings, bridge tokens, actions (no Electron imports, tested)
    bridge.ts     named-pipe server and pipe ACL clean-up
    preload.ts    contextBridge API
    logger.ts     redacting daily log files
    selftest.ts   the --self-test run
  renderer/     the sandboxed page: index.html, styles.css, main.ts (UI), detail.ts (panel), icons.ts
  extension/    browser extension logic (bundled by esbuild, unit tested): capture.ts (decision rules, settings),
                cookies.ts (per-site gating), flow.ts (hand-over and right-click behaviour, browser APIs injected),
                native.ts (messages to the host), background.ts (service worker), popup.ts
extension/      manifest.json (public key, permissions, CSP), popup.html/css, icons
host/           SareeaHost.cs: the native-messaging host (C# 5, compiled by csc.exe from the .NET Framework)
scripts/        build.mjs (esbuild), build-host.mjs (csc), start.mjs, package.mjs (packager + fuses + extension zip),
                fuses.mjs, zip.mjs, make-icon.mjs, make-extension-key.mjs, e2e-extension.mjs (real-browser test)
assets/         icon.png, icon.ico (drawn by scripts/make-icon.mjs)
docs/           protocol.md (the pipe), extension.md (extension, host, permissions, tests)
test/           node:test suites + a local range-capable test server (helpers.ts) + fixtures/FakeApp.cs
```

How a download runs:

1. **Probe** the URL (retrying transient errors). Pick a safe file name.
2. **Resume check.** If `<name>.sareea.json` exists for the same URL, compare ETag, Last-Modified and size with
   the fresh probe. Any difference: warn (`remote-changed`) and restart from zero. Otherwise continue
   from the saved segments.
3. **Segments.** The file is split into up to N segments and written with positional writes into a
   preallocated `<name>.part`. N workers each own a segment. A worker that finishes steals half of the
   largest remaining segment if more than 1 MiB is left (dynamic segmentation), so slow connections
   never become the tail. A segment's position is claimed before the write, so a steal can never overlap
   or double-fetch bytes.
4. **Every 206 is validated**: its Content-Range must equal the request. A 200 reply to a ranged request
   falls back to one plain connection (`ranges-ignored`). A changed ETag or size mid-download restarts once.
5. **Retry** per segment: transient network errors, stalls (30 s without data), 5xx, 429 and 408 retry with
   exponential backoff (0.5 s, 1 s, 2 s, ... up to 30 s, honouring Retry-After). Five consecutive
   failures without any progress fail the download. The sidecar is kept, so it can be resumed later.
6. **Finish**: check the size, compute SHA-256, compare with `expectedSha256`, rename `.part` to a unique
   final name (`name (1).ext` if the name is taken) and delete the sidecar.

If the server has no byte ranges or does not report a size, the download uses one connection, cannot be
resumed, and says so with a `single-connection` warning.

Files next to a download: `<name>.part` (data) and `<name>.sareea.json` (URL, size, ETag, segment
progress; flushed about once a second and on pause).

Engine security notes: only `http:` and `https:` (also for every redirect); Cookie, Authorization and
Proxy-Authorization are dropped when a redirect leaves the original origin; error messages show origin and
path only; the sidecar and queue file do contain the URL itself (needed to resume), so treat links with
tokens in the query string as sensitive; server-supplied file names are sanitised (path parts, `..`,
control and bidi characters, `<>:"/\|?*`, trailing dots, reserved device names, over-long names).

## Design decisions and limits

* **Queued vs paused.** "Add to queue" stores the item paused plus a flag in `meta.json`; the list shows it
  as Queued. Start queue resumes every paused item, Stop queue pauses everything running or waiting.
* **Delete** removes the entry. For an unfinished download its partial data is deleted too; a finished file
  stays on disk. **Delete with file** also deletes the finished file. **Redownload** removes the entry and
  adds the same link again; an existing finished file is kept, so the new one is saved as `name (1).ext`.
* **Folders.** With category subfolders on, the default folder gets `Compressed`, `Documents`, `Music`,
  `Programs`, `Video` or `General` (unknown types). A folder chosen with Browse is used as it is.
* **Cookies after a restart.** Headers are not stored, so a bridge download that was paused and survives an
  app restart resumes without its cookie (the server may refuse; send the link again from the browser).
* **Phase 3 decisions.** The native host is a small .NET Framework program (`host/SareeaHost.cs`), not a mode of
  the Electron exe: Electron writes a stray CR LF to stdout at start-up, which breaks the browser's length-prefixed
  framing (measured, details in [docs/extension.md](docs/extension.md)). The host is built with the `csc.exe` that
  ships with Windows, so users need neither Node nor an SDK. A browser download is held until the app accepts it
  and is cancelled only then, so an unreachable app never loses a download. Extension settings (file types,
  minimum size, pause) live in the extension; the app has no say in what the browser hands over. The extension is
  loaded unpacked; there is no store listing. `SAREEA_DL_TEST_DIR` keeps the app's data and pipe apart from a real
  install, for the end-to-end test only.
* **Not done:** code signing and an installer, proxy settings, scheduling, site grabber, video capture,
  auto-extraction, FTP, HTTP/2 specifics, a UI for changing the detail panel size, an Arabic popup, Firefox, and a
  store listing for the extension.
