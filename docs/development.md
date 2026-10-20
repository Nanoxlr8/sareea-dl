# Build, run and test

The README has the short version. This page is the full command list. Documentation index: [README](../README.md).

## Requirements

Windows 10/11 x64, Node 24 or newer and npm (developed on Node v24.14.1, npm 11). The engine, CLI and
tests run straight from the TypeScript sources with Node's type stripping. The app is bundled with
esbuild, so Electron does not need to strip types. Building (not running) the native-messaging host needs
`csc.exe`, the C# compiler that is part of the .NET Framework 4 on every Windows 10/11 PC.

## Run

```
npm install                    # once: electron, esbuild, @electron/packager
npm test                       # 321 tests (engine, app logic, IPC audit, build flavours, bridge, extension logic, native host), about 9 seconds
npm start                      # build the TEST flavour (dist-test/), then open the desktop app
npm start -- --self-test       # same, then prove an end-to-end download through the app and quit
npm run build                  # esbuild, RELEASE flavour -> dist/ (main.cjs, preload.cjs, renderer/, extension/, host/)
npm run build:test             # esbuild, TEST flavour    -> dist-test/
npm run package                # RELEASE: build + package -> out/Sareea DL-win32-x64/ (app + sareea-dl-host.exe),
                               #   out/extension and out/sareea-dl-extension.zip; fails if any test hook is found in it
npm run package:test           # TEST flavour -> out-test/ (self-test and end-to-end hooks; never ship it)
npm run check:release          # search the release package for test hooks (also part of `npm run package` and `npm test`)
npm run e2e:extension          # real Chrome (E2E_BROWSER=edge for Edge) + packaged TEST app (out-test/), throw-away profile
npm run dl -- <url> [options]  # the phase-1 command line tool
npm run icon                   # redraw assets/icon.png and icon.ico (already committed)
```

Note: npm 11 may skip Electron's download script during `npm install` (it warns about install scripts).
If `node_modules/electron/dist` is missing, run `node node_modules/electron/install.js` once. Run the npm
scripts from a normal path: they call `node scripts/*.mjs` directly because a `&` in the folder name
breaks `.bin` shims under cmd.exe.

Packaged app: `out/Sareea DL-win32-x64/Sareea DL.exe` (asar on, app icon, hardened fuses, see [security.md](security.md)), with
`sareea-dl-host.exe` next to it and the extension in `resources/extension`. That is the **release** flavour: it
contains no test hook. `out-test/` is the **test** flavour used by the self-test and the end-to-end test (see
"Build flavours" in [security.md](security.md)). `out/`, `out-test/`, `dist/` and `dist-test/` are not committed.

### Browser extension (phase 3)

Settings has **Install browser integration** and **Remove browser integration** (off by default, nothing registers
itself). Install, then load `out/extension` (or the folder the Settings button opens) in Chrome or Edge with
Developer mode, Load unpacked. Capture rules, the permission table and why each permission is needed, how cookies
are handled, how the host works, test results and limits: [docs/extension.md](extension.md).

### `--self-test`

Test flavour only (`npm start -- --self-test`, or `out-test/Sareea DL-win32-x64/Sareea DL.exe --self-test` after
`npm run package:test`). The release exe does not know the switch. It runs in a throw-away profile in the temp
folder and uses the real window. It checks that the page is served from `app://sareea/index.html` (not `file:`),
that the scheme handler serves only the renderer files and refuses traversal, that the page has no Node access
and no CSP errors, that hostile IPC calls are refused, that the bridge pipe answers and rejects bad input, then a
bridge "add" opens the prefilled Add dialog, "Start now" downloads
`https://proof.ovh.net/files/10Mb.dat` (10 485 760 bytes), the list shows it as completed, and the UI
flips to Arabic RTL. It prints `SELF-TEST PASS` or `FAIL` plus a JSON report (27 checks) and exits 0 or 1.
Options: `--self-test-out=<file>` (also write the JSON there), `--screenshot-dir=<dir>` (save PNGs and show the window).
It needs internet access, and leaves its temp profile (`%TEMP%\sareea-selftest-<pid>`) for you to delete.

### Regenerating the README screenshots

The pictures in [images](images) come from the test flavour only (the release build does not contain this code).
`--self-test-showcase=<dir>` stages six downloads from public servers (three finished, one running under a 2 MB/s
limit, one paused, one queued), opens the detail panel, the Add dialog, the context menu and Settings, switches theme and
language, and saves PNGs at a fixed 1.5x scale into `<dir>` (`src/main/showcase.ts`). It keeps its data in
`SAREEA_DL_TEST_DIR` (or a throw-away temp folder), never in the real profile, and exits when done. Use a neutral
folder so no personal path shows up in the pictures:

```
npm run package:test
set SAREEA_DL_TEST_DIR=C:\Users\Public\Sareea-demo
"out-test\Sareea DL-win32-x64\Sareea DL.exe" --self-test-showcase=C:\Users\Public\Sareea-demo\shots
```

The extension popup picture comes from the end-to-end run: set `E2E_SHOTS=<folder>` before `npm run e2e:extension` and it
writes `popup.png` (temporary browser profile, nothing of the real browser is touched). Delete the demo folder afterwards.
