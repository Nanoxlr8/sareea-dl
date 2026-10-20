// Flips Electron "fuses" in the packaged exe (compile-time switches that live in the binary).
// Fuse wire layout: SENTINEL, version byte, length byte, then one state byte per fuse:
// '0' (0x30) disabled, '1' (0x31) enabled, 'r' (0x72) removed in this Electron version.
import fs from 'node:fs';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

// Index in the V1 wire -> wanted state
export const FUSES = {
  0: ['RunAsNode', false], // ELECTRON_RUN_AS_NODE cannot turn the app into a Node interpreter
  1: ['EnableCookieEncryption', true],
  2: ['EnableNodeOptionsEnvironmentVariable', false], // NODE_OPTIONS is ignored
  3: ['EnableNodeCliInspectArguments', false], // --inspect and friends are ignored
  4: ['EnableEmbeddedAsarIntegrityValidation', true], // app.asar must match the hash embedded in the exe
  5: ['OnlyLoadAppFromAsar', true], // never run an app folder placed next to the exe
  6: ['LoadBrowserProcessSpecificV8Snapshot', false],
  // Off: the page is served from the app:// scheme (src/app/app-scheme.ts, handler in src/main/main.ts), so nothing
  // needs file:// privileges any more. (With it off a file:// page cannot be loaded from inside app.asar.)
  7: ['GrantFileProtocolExtraPrivileges', false],
  8: ['WasmTrapHandlers', true],
};

/** Patch the exe in place and return the resulting fuse states by name. */
export function applyFuses(exePath) {
  const buf = fs.readFileSync(exePath);
  const sentinel = Buffer.from(SENTINEL, 'ascii');
  const first = buf.indexOf(sentinel);
  if (first < 0) throw new Error('fuse sentinel not found in ' + exePath);
  if (buf.indexOf(sentinel, first + 1) >= 0) throw new Error('fuse sentinel found twice, refusing to patch');
  const version = buf[first + sentinel.length];
  const length = buf[first + sentinel.length + 1];
  if (version !== 1) throw new Error('unsupported fuse wire version ' + version);
  const start = first + sentinel.length + 2;
  const result = {};
  for (let i = 0; i < length; i++) {
    const cur = buf[start + i];
    const want = FUSES[i];
    if (!want) {
      result[`fuse#${i}`] = String.fromCharCode(cur);
      continue;
    }
    if (cur === 0x72) {
      result[want[0]] = 'removed';
      continue;
    }
    buf[start + i] = want[1] ? 0x31 : 0x30;
    result[want[0]] = want[1];
  }
  fs.writeFileSync(exePath, buf);
  return result;
}
