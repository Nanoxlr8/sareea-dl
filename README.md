# Sareea DL

A fast, resumable, multi-connection download manager for Windows, written from scratch in TypeScript.
Phase 1 is the engine, a command line tool and the test suite. Later phases add an Electron UI and a
Chrome/Edge extension that hands downloads to the engine.

* Zero runtime dependencies, zero dev dependencies. Only Node built-ins.
* TypeScript runs directly on Node 24 (type stripping): no build step.
* Original code. Nothing here is copied from IDM or any other download manager.

## Requirements

Node 24 or newer (developed on v24.14.1). On this version type stripping is on by default and prints no
warning, so no flag is needed. The code uses only erasable TypeScript syntax (no enums, namespaces or
parameter properties), so it should also run on other Node versions with type stripping (not tested).

## Run

```
npm test                       # 57 tests, about 7 seconds
npm run dl -- <url> [options]  # same as: node src/cli.ts <url> [options]
```

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

## Using the engine

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
const id = q.add({ url, dir });       // starts when a slot is free
q.on('progress', ({ id, downloaded, size, speed }) => {});
await q.pause(id); q.resume(id); await q.cancel(id, true); q.setLimit(1_000_000); q.list();
```

Queue events carry the id: `added`, `removed`, `state`, `settled`, `progress`, `done`, `warning`, `error`.

## Architecture

```
src/
  index.ts      public API
  download.ts   Download class: the engine (probe, segments, workers, retry, sidecar, verify, rename)
  probe.ts      HEAD, falls back to GET "Range: bytes=0-0"; size, ranges, ETag, Last-Modified, name, MIME
  segments.ts   pure logic: initial split, work stealing (split the largest remainder in half), validation
  throttle.ts   shared token-bucket Limiter, changeable at runtime
  queue.ts      Queue: concurrency cap, global limiter, pause/resume/cancel by id, JSON persistence
  filename.ts   Windows-safe names, Content-Disposition (incl. filename*=UTF-8''), uniqueName
  http.ts       thin node:http(s) client: redirects, no auto-decompression, error classes
  format.ts     size parsing and formatting for the CLI
  cli.ts        command line front end
test/           node:test suites + a local range-capable test server (helpers.ts)
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

Files next to the download: `<name>.part` (data) and `<name>.sareea.json` (URL, size, ETag, segment
progress; flushed about once a second and on pause). Both are gitignored.

## Security notes

* Only `http:` and `https:` URLs are accepted (also for every redirect).
* Header values (Cookie, Authorization, ...) are never logged, never put in error messages and never
  written to the sidecar or the queue file. The queue file records only that headers existed and
  their names. After a restart, `queue.resume(id, headers)` needs the headers again.
* Cookie, Authorization and Proxy-Authorization are dropped when a redirect leaves the original origin.
* Error messages show origin + path only, never the query string.
* The sidecar and queue file do contain the URL itself, which is needed to resume. Treat URLs with tokens
  in the query string as sensitive.
* File names from the server are sanitised: path parts, `..`, control and bidi characters,
  `<>:"/\|?*`, trailing dots and spaces, reserved device names (CON, NUL, COM1...) and over-long names.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Engine, CLI, tests | Done |
| 2 | Electron UI (queue list, progress, speed limit, tray) | Not started |
| 3 | Chrome/Edge MV3 extension (capture downloads, cookies and referrer) and a local bridge to the engine | Not started |

Not in phase 1: proxy settings, authentication prompts, FTP, HTTP/2 or HTTP/3 specifics, scheduling,
site grabber, video capture, bandwidth schedules, auto-extraction, a signed installer.
Electron's bundled Node must support type stripping (or add a build step) when phase 2 imports `src/index.ts`.
