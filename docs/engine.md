# Download engine and command line tool (phase 1)

The engine has zero runtime dependencies (Node built-ins only).

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
