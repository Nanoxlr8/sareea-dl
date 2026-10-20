// Release gate: a release package must contain no test hook.
//
// Searches the release app.asar (every file in it, the main bundle in particular) and the release host exe for
// the hook strings, as UTF-8 and as UTF-16LE (C# string literals are stored as UTF-16), and FAILS if any is found.
//   SAREEA_DL_TEST_DIR   test data folder / test pipe name (app and host)
//   SAREEA_DL_HOST_      host wait-limit overrides
//   --self-test          the self-test switch (also matches --self-test-out)
//   --screenshot-dir     the self-test screenshot switch
//
// Run: node scripts/check-release.mjs [app folder]     (default: out/Sareea DL-win32-x64; exit code 1 on a finding)
// Also called by scripts/package.mjs for the release flavour, and by test/release-flavour.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HOOK_STRINGS = ['SAREEA_DL_TEST_DIR', 'SAREEA_DL_HOST_', '--self-test', '--screenshot-dir'];

/** Every occurrence of a hook string in `buf`: [{ needle, encoding, offset }]. */
export function findHookStrings(buf, needles = HOOK_STRINGS) {
  const found = [];
  for (const needle of needles) {
    for (const [encoding, bytes] of [['utf8', Buffer.from(needle, 'utf8')], ['utf16le', Buffer.from(needle, 'utf16le')]]) {
      let at = buf.indexOf(bytes);
      while (at >= 0) {
        found.push({ needle, encoding, offset: at });
        at = buf.indexOf(bytes, at + 1);
      }
    }
  }
  return found;
}

/** Minimal asar reader (header = Pickle(JSON), file data after it). Returns Map(path in asar -> Buffer). */
export function readAsar(file) {
  const buf = fs.readFileSync(file);
  const headerSize = buf.readUInt32LE(4); // size of the header Pickle
  const jsonLength = buf.readUInt32LE(12); // string length inside the Pickle
  const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLength));
  const base = 8 + headerSize;
  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, p);
      else if (!entry.unpacked && entry.offset !== undefined) files.set(p, buf.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size));
    }
  };
  walk(header, '');
  return files;
}

/**
 * Check a packaged release app folder. Returns { ok, findings: [{ where, needle, encoding }], scanned: [names] }.
 * Throws if the asar or the host is missing, or the asar has no main bundle (a scan of nothing must not pass).
 */
export function checkReleaseApp(appDir) {
  const asar = path.join(appDir, 'resources', 'app.asar');
  const host = path.join(appDir, 'sareea-dl-host.exe');
  for (const p of [asar, host]) if (!fs.existsSync(p)) throw new Error(`release check: missing ${p}`);
  const findings = [];
  const scanned = [];
  const add = (where, buf) => {
    scanned.push(`${where} (${buf.length} bytes)`);
    for (const f of findHookStrings(buf)) findings.push({ where, needle: f.needle, encoding: f.encoding });
  };
  const files = readAsar(asar);
  const main = files.get('dist/main.cjs');
  if (!main || main.length < 10_000 || !main.includes('sareea:getState')) throw new Error('release check: app.asar has no usable dist/main.cjs');
  for (const [name, buf] of files) add(`app.asar:${name}`, buf);
  add('sareea-dl-host.exe', fs.readFileSync(host));
  return { ok: findings.length === 0, findings, scanned };
}

export function describeFindings(r) {
  return r.findings.map((f) => `  ${f.where}: found "${f.needle}" (${f.encoding})`).join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'out', 'Sareea DL-win32-x64');
  const r = checkReleaseApp(dir);
  if (r.ok) {
    console.log(`release check PASS: none of ${HOOK_STRINGS.join(', ')} in ${r.scanned.length} scanned items (UTF-8 and UTF-16)`);
  } else {
    console.error(`release check FAIL: test hooks found in the release package\n${describeFindings(r)}`);
    process.exit(1);
  }
}
