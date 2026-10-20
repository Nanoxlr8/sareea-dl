# Browser extension and native host (phase 3)

Sareea DL takes over downloads from Chrome and Edge. Three parts, all in this repository:

```
Chrome / Edge                                        this PC
┌─────────────────────────┐  native messaging  ┌──────────────────────┐  named pipe   ┌────────────┐
│ Sareea DL extension     │ ─────────────────▶ │ sareea-dl-host.exe   │ ────────────▶ │ Sareea DL  │
│ (MV3, no content script)│ ◀───────────────── │ (one message, exits) │ ◀──────────── │ app        │
└─────────────────────────┘   stdin / stdout   └──────────────────────┘  protocol v1  └────────────┘
```

* **Extension** (`extension/` + `src/extension/`): watches the browser's download list, decides what to hand
  over, adds a right-click item and a small popup. Built to `dist/extension`, copied to `out/extension` and
  `out/sareea-dl-extension.zip` by `npm run package`.
* **Native host** (`host/SareeaHost.cs`): a 34 KB program the browser starts for each message. It checks who
  called it, relays the message to the running app over the pipe described in [protocol.md](protocol.md), starts
  the app first if needed, writes one reply and exits.
* **App side**: Settings has "Install browser integration" and "Remove browser integration" (off by default;
  nothing registers itself). See "Registration" below.

## Install (for the person using it)

1. Run `npm run package`. The app is in `out/Sareea DL-win32-x64/` (it contains `Sareea DL.exe`,
   `sareea-dl-host.exe` and `resources/extension`).
2. Start Sareea DL, open Settings, press **Install browser integration**. Then press **Open extension folder**.
3. In Chrome or Edge open the extensions page (`chrome://extensions` or `edge://extensions`), turn on Developer
   mode, choose **Load unpacked** and pick that folder (or `out/extension`). The extension gets the same ID in
   both browsers: `jiakdemamdonheikpingfkfmgnehjedp`.
4. Download something. A matching file goes to Sareea DL. If the app is not running the browser starts it.

To undo: Settings, **Remove browser integration** (deletes both registry values and the host manifest), and remove
the extension in the browser. Unpacked extensions are used because there is no store listing yet.

## Permissions, and why each one is there

The manifest has **no content scripts**, **no static host permissions**, no `externally_connectable`, no
`web_accessible_resources`, and this extension-page policy:
`default-src 'none'; script-src 'self'; object-src 'none'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'`
(no inline script or style, no `eval`, no remote code, and the extension makes no network request of its own;
`connect-src 'none'` enforces that).

| Permission | Why it is needed | What it does not give |
|---|---|---|
| `downloads` | See a download as the browser starts it (`onDeterminingFilename`), cancel and erase it after Sareea DL took it, start it again in the browser when the right-click path fails | No access to file contents |
| `nativeMessaging` | Talk to `com.sareea.dl`, the host program | Only that one host name, and the host only accepts this extension's ID |
| `contextMenus` | The "Download with Sareea DL" item on links, images, video and audio | |
| `storage` | The popup settings (capture on/off, file types, minimum size, pause deadline, sites you declined), and in memory only: recent download sites and short-lived "we re-issued this URL" marks | Never cookies. Nothing leaves the browser |
| `cookies` | `chrome.cookies.getAll({url})` for the exact download URL, only when the user granted that origin | On its own it reads nothing: the cookies API also needs host permission for the URL |
| `optional_host_permissions`: `http://*/*`, `https://*/*` | Lets the user grant **one origin at a time**. Nothing is granted at install | Requested per origin on a user gesture only, revocable in the popup |

Deliberately **not** requested: `tabs`, `activeTab`, `webRequest`, `scripting`, `history`, `notifications`,
`<all_urls>`, any content script. (`manifest` and bundle rules are checked by `test/browser-integration.test.ts`.)

Consequences of holding no `tabs` or `activeTab`:

* The extension cannot read the address of the current tab, so the popup cannot say "allow cookies for this
  site". Instead it lists the sites of your recent downloads (origins only, kept in memory for the browser
  session) with an **Allow sign-in cookies** button, and has a box to type a site. The right-click item asks on
  the spot for the site of the link you clicked.
* No notification API: "Sareea DL not running" is shown as a red `!` badge and tooltip on the toolbar icon.
* No Alt-click bypass (that would need a content script). The popup has **Pause capture for 5 minutes** instead.

### Cookies, step by step

1. Nothing is granted by default. `getAll` is never called without a grant for the **exact origin** (scheme, host
   and port) of the download URL; a grant for another site, `http` vs `https`, a subdomain or another port does
   not count (unit-tested: with no grant `cookies.getAll` is not called at all).
2. A grant happens only in a click: the popup's **Allow sign-in cookies** button, or the right-click item on a
   site that is not granted and not declined. The browser shows its own permission prompt. Saying no is
   remembered (origin only), so the right-click item does not nag. A switch in the popup turns that question off.
3. With a grant, `getAll({url})` returns the cookies the browser would send to that URL (HttpOnly included). They
   are joined into one `Cookie` value, sent to the host in the one message for that download, relayed over the
   pipe, and kept by the app in memory for 10 minutes under a single-use token. They are not written to
   `chrome.storage`, not logged, not put in error messages, and not stored by the app (checked end to end: the
   cookie value is searched for in the extension's storage and in the app's data folder after the run).
4. **Revoke** in the popup removes the grant (`chrome.permissions.remove`).

## What gets captured

`chrome.downloads.onDeterminingFilename` fires for every browser download once the response headers are in.
The extension captures it when **all** of these hold: capture is on and not paused; the URL is `http` or `https`
(not `blob:`, `data:`, `file:`, `ftp:`); it is not an incognito download; it was not started by this extension
itself; and the file name or URL ends in a listed type, **or** the size is known and at least the minimum.

Defaults: types `zip 7z rar tar gz tgz bz2 xz zst cab exe msi msix appx dmg pkg deb rpm apk jar iso img mp4 mkv
avi mov wmv flv webm m4v mpg mpeg mp3 flac wav aac ogg m4a wma opus pdf`, minimum size 1 MB (0 turns the size
rule off). Both are editable in the popup under "Capture rules". (`ts` is left out on purpose: it is TypeScript
source as often as video.)

Hand-over order, chosen so that a download is never lost:

1. The extension holds the download at the file-name step (it does not call `suggest` yet).
2. It sends `{type:"add", url, fileName, referrer, headers:{cookie?, userAgent}}` to the host.
3. **Only after the app says yes** it cancels and erases the browser's download. If the host is missing, the app
   cannot be started, or the app refuses (for example `duplicate`), it calls `suggest()` and the **same**
   download simply continues in the browser, and the badge shows `!`. No restart, no loop. The browser's request
   was already sent when we intercept (that is how every extension that uses the downloads API works), so a
   server that hands out one-time links may see that first request.
4. The right-click path has no browser download to hold. If the app cannot take it, the extension starts it with
   `chrome.downloads.download` and marks the URL (and the `byExtensionId` check) so it is not captured again.

`referrer` follows the browser's default policy (full address to the same site, only the origin to another site,
nothing from https to http), so the full address of the page you were on does not go to the download server.

## Native host details

| | |
|---|---|
| Program | `sareea-dl-host.exe`, next to `Sareea DL.exe` |
| Started by | Chrome / Edge, as `<exe> chrome-extension://<id>/ [--parent-window=...]` |
| Reads | one frame from stdin: 4-byte little-endian length, then UTF-8 JSON; length 1 to 1 048 576 bytes, checked before any allocation |
| Accepts | `{type:"ping"}`, `{type:"open"}`, `{type:"add", url, fileName?, referrer?, pageUrl?, headers?{cookie?, userAgent?}}`; any other type or top-level field is an error. `v` and `id` are set by the host, never by the caller |
| Origin | the first `chrome-extension://` argument must equal `chrome-extension://jiakdemamdonheikpingfkfmgnehjedp/` exactly, otherwise `origin not allowed` and exit code 2 before reading anything. The native-host manifest's `allowed_origins` lists only that ID too |
| `add` | relays to the pipe; if the pipe does not exist it starts `Sareea DL.exe` (normal mode, detached, no inherited handles) and retries every 120 ms for up to 5 s; a request that was delivered is never sent twice |
| `ping` | relays once; never starts the app. Reply `{ok:false,error:"app-not-running"}` when it is down |
| `open` | starts the app (a second copy just shows the first one's window) |
| Replies | one frame `{v:1, ok, error?}`. `error` is a short fixed text or the app's own refusal text; it never contains a URL, cookie or header value |
| Limits | 10 s to receive the message, 20 s for the app's answer (the app may probe the link first), 45 s hard stop |
| Logging | none: nothing is logged or written to disk |

The origin argument is a consistency check, not authentication: any local process can pass it. What protects the
app is the same as for any bridge client: the pipe is limited to your user, the app validates every field, and
without "Start browser downloads without asking" a request only opens a prefilled Add dialog that you confirm.

### Why a small .NET program and not the Electron exe

The plan preferred a host mode inside `Sareea DL.exe`. It was built and measured first:

* Speed was fine: the packaged Electron exe, started as a host, ran our code and exited in **64 to 74 ms**
  (190 ms the first time), far below the 1.5 s limit. (Reading stdin worked too, with `fs.read(0)` on the
  inherited handle; the relay to the pipe was never built in that mode.)
* It cannot be used, because **Electron's own start-up writes a stray `CR LF` to stdout before any application
  code runs** (seen with the stock `electron.exe`, with an app that does nothing, with stdout as a pipe or a
  file, with and without a console on the parent, and with `ELECTRON_NO_ATTACH_CONSOLE`; it does not happen in
  `ELECTRON_RUN_AS_NODE` mode). Chrome would read `0D 0A` as the first half of the length prefix and drop the
  connection. A workaround exists (make the first reply frame's length field start with the two bytes that are
  already there) but depends on an undocumented start-up detail, so it was not used. Also `process.stdin` is a
  dead stream in a GUI-subsystem Electron process (the data has to be read from fd 0 directly). Turning on the
  `RunAsNode` fuse would avoid both problems but removes a hardening step from phase 2, so it was not done.
* `sareea-dl-host.exe` is C# 5 compiled by `csc.exe`, the compiler that ships inside the .NET Framework 4 of every
  Windows 10 and 11 PC (`scripts/build-host.mjs`, no SDK and no Node needed to build or run the result). It starts
  in a few tens of milliseconds and writes nothing to stdout except the reply. The allowed origin and the app's
  exe name are generated into it from `src/app/browser-integration.ts`, so the host and the app cannot disagree.

Measured on this PC (Windows 11, Chrome 155 and Edge 155):

| Measurement | Result |
|---|---|
| Host process, app running: spawn, pipe round trip, exit (`test/host.test.ts`, median of 5) | about 95 ms |
| Ping from the browser through the host (`sendNativeMessage`, includes the browser's own overhead), median of 5 | 117 to 148 ms |
| Click to finished 2 MB file in the app, app already running | about 310 to 320 ms |
| Same, app not running (the host starts it, waits for its pipe) | about 630 to 780 ms |

## Registration (Settings buttons)

"Install browser integration" does exactly this, with no admin rights:

1. writes `%APPDATA%\Sareea DL\native-messaging\com.sareea.dl.json`
   (`{"name":"com.sareea.dl","description":"Sareea DL browser integration","path":"<...>\\sareea-dl-host.exe","type":"stdio","allowed_origins":["chrome-extension://jiakdemamdonheikpingfkfmgnehjedp/"]}`);
2. sets the default value of `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sareea.dl` and
   `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.sareea.dl` to that file, using `reg.exe` by absolute path
   with an argument list (no shell).

"Remove browser integration" deletes both values and the manifest. The buttons only work in the packaged app
(a development run has no host program to point to). The status line shows Chrome and Edge as installed, not
installed, or pointing to another copy (press Install to update).

## Extension ID and key

`extension/manifest.json` has a `key` (a public key), so the extension ID is the same on every machine and in both
browsers. The **private key is not in the repository**: `node scripts/make-extension-key.mjs` generated it into
`secrets/extension-private-key.pem`, and `.gitignore` excludes `secrets/`, `*.pem` and `*.crx`. Keep that file
somewhere safe if you ever want to pack a signed `.crx` with the same ID; losing it does not break anything that
exists today. The script refuses to overwrite it. If you do replace the key the ID changes: update `EXTENSION_ID` in
`src/app/browser-integration.ts` (a unit test recomputes the ID from the manifest and fails if they differ) and
rebuild.

## Tests

* **Unit tests** (`npm test`, no browser needed): capture decision (types, size, schemes, pause, incognito, own
  downloads), cookie permission gating (no grant, no `getAll`), the hand-over flow and the right-click flow with
  every browser API faked, message framing (limits, split chunks, bad UTF-8), the host program itself (compiled
  by the test and driven like a browser: origin check, relay, app start, timeouts, bad frames, no echo of
  secrets), host manifest generation, registration with a fake `reg.exe`, extension ID derived from the key, and
  audit rules on the manifest and on the bundled scripts (no content scripts, exact permission list, CSP, no
  `eval`, no `fetch`, no `tabs`/`scripting`/`webRequest`, no logging).
* **End to end** (`npm run e2e:extension`, needs `npm run package` first and Chrome or Edge; set
  `E2E_BROWSER=edge` for Edge): real browser, real packaged app, real host.
  * Chrome starts with a temporary `--user-data-dir`, headless, and a loopback test site on `127.0.0.1`.
    Chrome 137 and later ignore `--load-extension` in branded builds, so the harness loads the extension with
    CDP `Extensions.loadUnpacked` over `--remote-debugging-pipe` (Edge 155 still honours `--load-extension`).
    The browser's download folder is set in the temporary profile's preferences (not through CDP, because
    CDP download control bypasses the extension hook).
  * The app runs with `SAREEA_DL_TEST_DIR` (own data folder and own pipe name), so a real installation is never
    touched. `SAREEA_DL_HOST_STARTUP_MS`, `SAREEA_DL_HOST_REPLY_MS` and `SAREEA_DL_HOST_READ_MS` shorten the
    host's waits in tests; they are harmless otherwise.
  * It registers the host under HKCU for the run only (and refuses to start if the key already exists), then
    removes the keys and verifies they are gone, deletes the temporary profile, and kills only the processes it
    started itself.
  * Checks (70 on Chrome 155, 70 on Edge 155): extension loads with the expected ID and exactly the five
    permissions and no site granted; with no host registered the download carries on in the browser and the badge
    turns on; with the app not running the host starts it and the file arrives byte-exact (sha256 and size), the
    browser's own download is cancelled and erased and nothing is left in its download folder; with the app
    running the same; capture by size for an unknown type; an unlisted small type and the paused state stay in the
    browser; the popup shows the status and the pause button works; **no cookie reaches the app when the origin
    is not granted, although the browser's own request carried it**; in a second run with `127.0.0.1` granted
    (test-only copy of the extension with `host_permissions: ["http://127.0.0.1/*"]`, same key, same ID) the
    cookie including the HttpOnly one reaches the app, while the same file on `localhost`, which is not
    granted, gets none; no error or warning in the extension's console; the cookie value is not in the extension's
    storage or in the app's data folder; the app started by the host survives the host's exit.

Not covered by the end-to-end run: the browser's real permission prompt and the right-click menu are native
browser UI that cannot be clicked through CDP. They are covered by the unit tests with the browser APIs faked.
The permission request relies on the browser carrying the click's user gesture through the extension API calls the
service worker starts while handling the click; that is why settings are read inside the click rather than at
start-up. If a future browser refuses the request, nothing breaks: the download goes without cookies and the site
is not marked as declined.

## Known limits

* Unpacked only: no store listing, no signed `.crx`, no installer, the exe and the host are not code-signed.
* The popup is English only (the app has Arabic).
* No site list for "never capture", no per-site rules beyond the file types and minimum size.
* Cross-origin redirects: the cookie is only fetched for the URL the browser started with, and the engine drops
  it when a redirect leaves that origin.
* The downloads API does not say how a download was requested. A download that needs a `POST` (a form button) or
  a one-time link that the browser's first request already used up will be captured and then fail in the app,
  because the app asks again with a plain `GET`. For such a site use **Pause capture for 5 minutes** (or turn
  capture off) in the popup. `blob:` and `data:` downloads are never captured.
* Firefox is not supported (different manifest and host registration).
