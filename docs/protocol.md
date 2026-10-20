# Sareea DL local bridge protocol (version 1)

How the browser extension (phase 3) hands a download to the running desktop app:

```
browser extension  --native messaging-->  native host (small exe/script)  --named pipe-->  Sareea DL app
```

The native host is a thin relay. It copies the extension's message onto the pipe and the app's reply
back. The app does all validation, so the host does not need to be trusted for safety.

## Transport

| | |
|---|---|
| Pipe name | `\\.\pipe\sareea-dl-<username>` |
| `<username>` | the Windows user name (`%USERNAME%`) with every character outside `A-Z a-z 0-9 . _ -` replaced by `_`, at most 64 characters |
| Framing | UTF-8, one JSON object per line, lines end with `\n` (a trailing `\r` is ignored, blank lines are skipped) |
| Direction | client sends requests, the app sends exactly one reply per request, in order |
| Access | the pipe is restricted to the signed-in user, Administrators and SYSTEM (Everyone and Anonymous are removed right after the app starts listening) |

The app listens only while it is running. If connecting fails (file not found), the app is not
running: the host should start `Sareea DL.exe` and retry, or tell the extension to fall back to the
browser's own download.

Per connection: at most 50 requests, closed after 15 seconds without data, at most 8 connections at
a time. A line longer than 64 KiB is answered with `line too long` and the connection is closed.

## Request

```json
{
  "v": 1,
  "id": "r-1",
  "type": "add",
  "url": "https://example.com/files/setup.zip",
  "fileName": "setup.zip",
  "referrer": "https://example.com/download",
  "headers": { "cookie": "session=abc; theme=dark", "userAgent": "Mozilla/5.0 ..." },
  "pageUrl": "https://example.com/download"
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `v` | number | yes | must be `1` |
| `id` | string or integer | yes | string of 1 to 64 characters without control characters, or a non-negative integer. Echoed in the reply |
| `type` | string | yes | `"add"` or `"ping"` |
| `url` | string | for `add` | `http:` or `https:` only, a valid URL with a host, at most 8192 characters, no whitespace or control characters |
| `fileName` | string | no | at most 255 characters, no control characters. A suggestion: the user can change it in the Add dialog. Characters Windows does not allow are replaced |
| `referrer` | string | no | `http(s)` URL, at most 8192 characters. Sent as the `Referer` header |
| `pageUrl` | string | no | `http(s)` URL, at most 8192 characters. Used as `Referer` when `referrer` is absent |
| `headers.cookie` | string | no | at most 16384 characters; no control characters except tab (so no CR or LF) |
| `headers.userAgent` | string | no | at most 512 characters; same character rule |

Rules that apply to every request:

* No other field is accepted, at any level. An unknown field is an error (this lets us add fields
  later without older apps silently ignoring something important).
* `null`, `""` and a missing optional field mean the same thing: not given.
* A `ping` takes only `v`, `id` and `type`.

## Reply

```json
{ "v": 1, "id": "r-1", "ok": true }
{ "v": 1, "id": "r-1", "ok": false, "error": "only http and https links are supported" }
```

`id` is `null` when the request was so broken that its id could not be read. `error` is a short
English text for logs, not for showing to users. It never contains the URL, a cookie or a header value.

`ok: true` on an `add` means the app accepted the request: either the Add dialog is now open
(default) or the download was queued (see below). It does not mean the download finished.

Error texts you can expect: `invalid JSON`, `request must be a JSON object`, `id must be a string
(1-64 characters) or a non-negative integer`, `unsupported protocol version (expected 1)`, `type must
be "add" or "ping"`, `unknown field <name>`, `unknown header field <name>`, `url is required`, `url is
too long`, `only http and https links are supported`, `<field> is too long`, `<field> contains control
characters`, `line too long`, `too many requests on one connection`, `duplicate`, `internal error`.

## What the app does with an `add`

1. Validates the request strictly (above). Nothing else happens on a failure.
2. Keeps the `Cookie`, `User-Agent` and `Referer` values **in memory only**, under a random token that
   lives for 10 minutes and is used by exactly one download. The token is the only thing the window ever
   sees (it learns that a cookie exists, never its value).
3. Default: shows the Add dialog prefilled with the URL and file name. The user checks it and presses
   Start now or Add to queue. The reply `ok: true` is sent as soon as the dialog is requested.
4. With the setting **Start browser downloads without asking** on (off by default): probes the link,
   adds the download to the default folder (category subfolder if enabled) and starts it. A link that
   is already in the list answers `{ "ok": false, "error": "duplicate" }`.

The cookie is never written to disk, never logged, and is dropped after the download is added.
Consequence: if the app is restarted while such a download is paused, resuming it asks the server
without the cookie. The server may refuse; the browser extension can then send the link again.

## Examples

Windows PowerShell:

```powershell
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', "sareea-dl-$env:USERNAME", 'InOut')
$pipe.Connect(2000)
$w = New-Object System.IO.StreamWriter($pipe); $w.AutoFlush = $true
$r = New-Object System.IO.StreamReader($pipe)
$w.WriteLine('{"v":1,"id":"1","type":"ping"}')
$r.ReadLine()          # {"v":1,"id":"1","ok":true}
```

Node.js:

```js
import net from 'node:net';
const sock = net.connect(String.raw`\\.\pipe\sareea-dl-` + process.env.USERNAME);
sock.setEncoding('utf8');
sock.on('data', (d) => console.log(d));
sock.write(JSON.stringify({ v: 1, id: 'a', type: 'add', url: 'https://example.com/a.zip' }) + '\n');
```

## Versioning

`v` is the protocol version. A change that old apps cannot understand raises it. The app answers a
different version with `unsupported protocol version`, so a newer host can detect an older app by
sending a `ping` with the version it wants and reading the answer.

## Where it is implemented

* `src/app/protocol.ts`: parsing, validation, limits, reply format and the line splitter (pure, tested in `test/app-protocol.test.ts`).
* `src/main/bridge.ts`: the pipe server (tested over a real pipe in `test/app-bridge.test.ts`).
* `src/main/controller.ts`: `handleBridgeAdd`, the token store and the auto-start rule.
