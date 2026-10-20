# Architecture, design decisions and limits

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
    api.ts        view types and the window.sareea API type (channel names are literals in preload.ts / main.ts, not here)
    app-scheme.ts the app://sareea scheme: constants and resolveAppRequest (URL -> file inside the renderer folder, or refusal)
    ipc.ts        validators for every renderer request, sender check (isTrustedSender), folder rules
    test-hooks.ts test-flavour only: SAREEA_DL_TEST_DIR, --self-test switches, pipe suffixes (absent from the release bundle)
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
    bridge.ts     named-pipe server and pipe ACL clean-up (buildPipeAclCommand: absolute powershell.exe, fixed arguments)
    preload.ts    contextBridge API, literal IPC channels
    logger.ts     redacting daily log files
    selftest.ts   the --self-test run (test flavour only)
    showcase.ts   the --self-test-showcase run that stages downloads and saves the README screenshots (test flavour only)
  renderer/     the sandboxed page: index.html, styles.css, main.ts (UI), detail.ts (panel), icons.ts
  extension/    browser extension logic (bundled by esbuild, unit tested): capture.ts (decision rules, settings),
                cookies.ts (per-site gating), flow.ts (hand-over and right-click behaviour, browser APIs injected),
                native.ts (messages to the host), background.ts (service worker), popup.ts
extension/      manifest.json (public key, permissions, CSP), popup.html/css, icons
host/           SareeaHost.cs: the native-messaging host (C# 5, compiled by csc.exe from the .NET Framework)
scripts/        build.mjs (esbuild, release and test flavours), build-host.mjs (csc, with or without TEST_HOOKS), start.mjs,
                package.mjs (packager + fuses + extension zip + release gate), check-release.mjs (hook-string gate),
                fuses.mjs, zip.mjs, make-icon.mjs, make-extension-key.mjs, e2e-extension.mjs (real-browser test, test flavour)
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
  framing (measured, details in [docs/extension.md](extension.md)). The host is built with the `csc.exe` that
  ships with Windows, so users need neither Node nor an SDK. A browser download is held until the app accepts it
  and is cancelled only then, so an unreachable app never loses a download. Extension settings (file types,
  minimum size, pause) live in the extension; the app has no say in what the browser hands over. The extension is
  loaded unpacked; there is no store listing. The end-to-end test keeps the app's data and pipe apart from a real
  install with `SAREEA_DL_TEST_DIR`, which exists only in the test flavour (see [security.md](security.md), Build flavours).
* **Not done:** code signing and an installer, proxy settings, scheduling, site grabber, video capture,
  auto-extraction, FTP, HTTP/2 specifics, a UI for changing the detail panel size, an Arabic popup, Firefox, and a
  store listing for the extension.
