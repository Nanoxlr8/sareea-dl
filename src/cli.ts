import { parseArgs } from 'node:util';
import { Download } from './download.ts';
import type { ProgressInfo } from './download.ts';
import { formatBytes, formatEta, formatSpeed, parseSize } from './format.ts';
import { Limiter } from './throttle.ts';

const USAGE = `Sareea DL - segmented, resumable downloader

Usage: node src/cli.ts <url> [options]

  -o, --out <dir>        Output folder (default: current folder)
  -c, --connections <n>  Parallel connections, 1-32 (default: 8)
      --limit <rate>     Speed limit, e.g. 500K, 2M (bytes/s, default: unlimited)
  -n, --name <file>      Save as this file name
  -H, --header <h>       Extra request header "Name: value" (repeatable; values are never printed)
      --sha256 <hex>     Fail unless the finished file has this SHA-256
  -h, --help             Show this help

Press Ctrl+C to pause; run the same command again to resume.`;

function fail(msg: string, code = 2): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      connections: { type: 'string', short: 'c' },
      limit: { type: 'string' },
      name: { type: 'string', short: 'n' },
      header: { type: 'string', short: 'H', multiple: true },
      sha256: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  fail(`${(e as Error).message}\n\n${USAGE}`);
}

if (args.values.help) {
  console.log(USAGE);
  process.exit(0);
}
const url = args.positionals[0];
if (!url || args.positionals.length > 1) fail(USAGE);

const headers: Record<string, string> = {};
for (const h of (args.values.header as string[] | undefined) ?? []) {
  const i = h.indexOf(':');
  if (i <= 0) fail('Invalid --header, expected "Name: value"');
  headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
}

let connections = 8;
if (args.values.connections !== undefined) {
  connections = Number(args.values.connections);
  if (!Number.isInteger(connections) || connections < 1 || connections > 32) fail('--connections must be 1-32');
}

let limiter: Limiter | undefined;
if (args.values.limit !== undefined) {
  try {
    limiter = new Limiter(parseSize(String(args.values.limit)));
  } catch (e) {
    fail((e as Error).message);
  }
}

let download: Download;
try {
  download = new Download({
    url,
    dir: String(args.values.out ?? '.'),
    connections,
    fileName: args.values.name as string | undefined,
    headers,
    limiter,
    expectedSha256: args.values.sha256 as string | undefined,
  });
} catch (e) {
  fail((e as Error).message);
}

const tty = process.stdout.isTTY;
let lastPlain = 0;

function line(p: ProgressInfo): string {
  const pct = p.size ? `${((p.downloaded / p.size) * 100).toFixed(1).padStart(5)}%` : '   ?%';
  const total = p.size ? formatBytes(p.size) : '?';
  return `${pct}  ${formatSpeed(p.speed).padStart(10)}  ETA ${formatEta(p.eta)}  ${formatBytes(p.downloaded)} / ${total}`;
}

function show(text: string, final = false): void {
  if (tty) {
    process.stdout.write(`\r${text.padEnd(Math.max(0, (process.stdout.columns ?? 80) - 1))}${final ? '\n' : ''}`);
  } else if (final || Date.now() - lastPlain > 2000) {
    lastPlain = Date.now();
    process.stdout.write(`${text}\n`);
  }
}

download.on('state', (s) => {
  if (s === 'probing') console.log('Probing...');
  if (s === 'verifying') console.log('\nVerifying...');
});
download.on('warning', (w: { message: string }) => console.log(`\nNote: ${w.message}`));
download.on('progress', (p: ProgressInfo) => show(line(p)));
download.on('done', (d: { path: string; sha256: string }) => {
  console.log(`Saved: ${d.path}`);
  console.log(`SHA-256: ${d.sha256}`);
});
download.on('error', (e: Error) => console.error(`\nError: ${e.message}`));

let interrupted = false;
function onInterrupt(): void {
  if (interrupted) process.exit(1);
  interrupted = true;
  console.log('\nPausing...');
  void download.pause();
}
// SIGINT = Ctrl+C. SIGBREAK = Ctrl+Break / closing the console on Windows. SIGTERM = kill.
for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM'] as const) process.on(sig, onInterrupt);

const finalState = await download.start();
if (finalState === 'done') process.exit(0);
if (finalState === 'paused') {
  console.log('Paused. Run the same command again to resume.');
  process.exit(130);
}
process.exit(1);
