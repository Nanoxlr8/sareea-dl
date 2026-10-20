# Security model

The short version and the audit summary are in the [README](../README.md#privacy-and-security-by-design). This page is the full description.

The goal: a page that is only ever our own bundled files, no network from the UI, a very small and
validated surface between the page and the system, no secrets on disk, and no test hook in what ships.

**Build flavours (no test hooks in the release)**

* Two flavours of everything, chosen by the build, not by a flag at run time:
  * **release** (`npm run build`, `npm run package`): `dist/`, `out/`. esbuild's `define`
    `__SAREEA_TEST_HOOKS__=false` plus syntax minification remove every branch, import and helper that only the
    test hooks use, so the bundle has no self-test code and none of the strings below. The native host is compiled
    without `TEST_HOOKS`, so `host/SareeaHost.cs` keeps its `#if TEST_HOOKS` code out of the exe and reads no
    environment variable at all.
  * **test** (`npm start`, `npm run build:test`, `npm run package:test`): `dist-test/`, `out-test/`. `__SAREEA_TEST_HOOKS__=true` and
    `csc /define:TEST_HOOKS`. Used only by `--self-test` and `npm run e2e:extension`. Never ship it.
* The hooks, all of which exist only in the test flavour: `SAREEA_DL_TEST_DIR` (app data folder and pipe name for
  the app, pipe name for the host), `SAREEA_DL_HOST_READ_MS` / `_STARTUP_MS` / `_REPLY_MS` (host wait limits),
  `--self-test`, `--self-test-out=`, `--screenshot-dir=`, `--self-test-showcase=` (README screenshots; it contains `--self-test`, so the gate
  below already covers it). Their code lives in `src/app/test-hooks.ts`, `src/main/selftest.ts` and `src/main/showcase.ts`, reached from `main.ts` only through `__SAREEA_TEST_HOOKS__`.
* Why it matters: a process that can set environment variables for the browser could otherwise redirect the host to
  a `-test-` pipe it owns and receive download URLs and cookies.
* The gate: `scripts/check-release.mjs` searches every file in the release `app.asar` (main bundle included) and
  the release `sareea-dl-host.exe` for `SAREEA_DL_TEST_DIR`, `SAREEA_DL_HOST_`, `--self-test` and `--screenshot-dir`,
  as UTF-8 and UTF-16 (C# strings), and fails (exit code 1) if any is present. It runs at the end of
  `npm run package`, and `npm test` (`test/release-flavour.test.ts`) builds both flavours of the app and the host, checks the
  release bytes, checks that the test flavour does contain the hooks (so the scan is not blind), checks that the
  release host ignores `SAREEA_DL_TEST_DIR` (it never connects to a `-test-` pipe), and runs the gate on synthetic
  good and bad packages and on `out/` if it has been built.

**Window and renderer**

* `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, no webviews,
  no remote module, DevTools disabled in the packaged app, no application menu, spellcheck off.
* The only page is `app://sareea/index.html`, served from a custom scheme and not from `file://`. `app` is registered
  (before the app is ready) as `standard` and `secure` only: no fetch API, no CORS, no service workers, no CSP bypass.
  `protocol.handle('app', ...)` in `main.ts` answers GET requests only, and maps them through
  `resolveAppRequest` (`src/app/app-scheme.ts`) to the files of one folder, `dist/renderer` (inside `app.asar` when
  packaged). It refuses a wrong scheme or host, a port or credentials, `.` / `..` segments (also percent-encoded or
  double-encoded), `\`, `:`, NUL and control characters, empty segments, trailing dots or spaces, extensions other
  than html, js, css, png and svg, and any resolved path that is not inside the renderer folder.
  Unit-tested with the traversal spellings; the self-test repeats the important ones against the running app.
  Strict CSP in the page: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` (`'self'` is now exactly `app://sareea`).
  No inline script or style attributes; text from the engine or network is only ever set with `textContent`.
* `will-navigate`, `will-redirect` and `will-attach-webview` are blocked; `setWindowOpenHandler` denies
  every window and opens only validated `http(s)` links through `shell.openExternal`.
* Permission requests are denied. Any request from the UI to `http(s)`, `ws(s)`, `ftp` or `file` is cancelled
  and logged: the engine downloads from the Node side, the UI never touches the network or the local disk.
* The preload script exposes one frozen object, `window.sareea`, with one method per action
  (`src/app/api.ts`). No generic IPC access.

**IPC**

* Channel names are string literals at every call site, never a map or a variable: `ipcRenderer.invoke('sareea:add', ...)`
  in `src/main/preload.ts`, `ipcMain.handle('sareea:add', ...)` in `src/main/main.ts`, `webContents.send('sareea:ev:items', ...)`
  for events. 21 request channels, one preload method and one handler each; 5 event channels. A static tool (or a
  reader) can pair every call with its handler. `test/ipc-channels.test.ts` runs the bundled preload against a
  recording stand-in for `electron` and checks that each exposed method maps to exactly one literal channel, that the
  channels are exactly the handlers' channels, that every handler's first statement is the sender check and its
  second step its own validator, that no other `ipcMain` entry point exists, and that the release bundle keeps all 21
  handlers literal.
* Every `ipcMain.handle` calls `rejectUntrusted` first: the sender must be the main window's top frame and its
  URL must be exactly our own `app://sareea/index.html` (`isTrustedSender`: scheme, host and path; a `file:` URL, another
  host, a port or credentials never match). Anything else is refused and logged.
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
  Everyone and Anonymous read; right after listening the app removes those two entries, leaving the user,
  Administrators and SYSTEM. Even before that, nobody else could write to it.
* That clean-up runs `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` by absolute path (never through
  `PATH`; `%SystemRoot%` is used only if it is a plain absolute local path, else `C:\Windows`) with the constant
  arguments `-NoProfile -NonInteractive -Command <fixed script>`. Nothing derived from the user name is in the command line or
  the script: the pipe name (user name reduced to `A-Za-z0-9._-`, at most 64 characters, and checked again against
  that set before use) reaches the script as the environment variable `SAREEA_PIPE_NAME`, which the script reads as data.
  `buildPipeAclCommand` in `src/main/bridge.ts` builds the call; `test/bridge-acl.test.ts` checks it with hostile user names
  such as `a';calc;'`, backticks, `$(...)`, `&`, quotes, line breaks and over-long names, and also tightens a real pipe named
  after such a user.
* Strict validation, size limits on every field, 64 KiB per line, 8 connections, 50 requests per
  connection, 15 s idle timeout. With "start without asking" off (the default) a request can only open a
  prefilled dialog; the user decides.

**Browser extension and native host** (details and the permission table: [docs/extension.md](extension.md))

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
from `app.asar`, WebAssembly trap handlers on, and **`GrantFileProtocolExtraPrivileges` off** (it used to have to
stay on, because a `file://` page cannot be loaded from inside `app.asar` without it; the page now comes from the
`app://` scheme, so nothing needs file privileges). A packaged app also refuses `--inspect`, `--debug` and
`--remote-debugging-*` switches. The app is not code-signed. The fuse states are printed by `npm run package`; both
flavours get the same fuses, and the packaged app loading and working with the fuse off is shown by the self-test on
`out-test/` (27 checks) and by a plain launch of the release exe, whose log says `page loaded from app://sareea/index.html`
and `UI ready` (the page reached the main process through the sender check) with no warning or error.
