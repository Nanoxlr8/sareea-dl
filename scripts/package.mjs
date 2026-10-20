// Build, then package for Windows x64 (asar on, app icon) and harden the Electron binary by flipping its fuses.
//   npm run package        RELEASE flavour -> out/Sareea DL-win32-x64     (no test hooks; scripts/check-release.mjs must pass)
//   npm run package:test   TEST flavour    -> out-test/Sareea DL-win32-x64 (self-test + e2e hooks; never ship it)
import { packager } from '@electron/packager';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll, FLAVOURS, flavourFromArgs } from './build.mjs';
import { checkReleaseApp, describeFindings } from './check-release.mjs';
import { applyFuses } from './fuses.mjs';
import { zipDirectory } from './zip.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const require = createRequire(import.meta.url);

const flavour = flavourFromArgs(process.argv.slice(2));
const flavourInfo = FLAVOURS[flavour];
if (!flavourInfo) throw new Error(`unknown flavour: ${flavour}`);
const distDir = at(flavourInfo.dir);
await buildAll({ flavour });

// Stage only what the app needs at run time: the bundles and the renderer (always as dist/ inside the app), and a
// minimal package.json (no scripts, no dev tools). The host exe and the extension travel next to the app, not inside it.
const stage = at('.tmp', `stage-${flavour}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(distDir, path.join(stage, 'dist'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(distDir, src).split(path.sep)[0];
    return rel !== 'host' && rel !== 'extension' && rel !== 'package.json';
  },
});
const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: 'dist/main.cjs', license: pkg.license }, null, 2),
);

const electronVersion = require('electron/package.json').version;
const out = at(flavour === 'release' ? 'out' : 'out-test');
const [appDir] = await packager({
  dir: stage,
  out,
  name: 'Sareea DL',
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  asar: true,
  // the built browser extension travels with the app (resources/extension) so Settings can open its folder
  extraResource: [path.join(distDir, 'extension')],
  overwrite: true,
  prune: false,
  icon: at('assets', 'icon.ico'),
  appVersion: pkg.version,
  appCopyright: 'Sareea DL',
  win32metadata: { CompanyName: 'Sareea', FileDescription: 'Sareea DL download manager', ProductName: 'Sareea DL', InternalName: 'Sareea DL', OriginalFilename: 'Sareea DL.exe' },
});

const exe = path.join(appDir, 'Sareea DL.exe');
// The native-messaging host sits next to the app exe: the browsers start it, it relays to the running app.
fs.copyFileSync(path.join(distDir, 'host', 'sareea-dl-host.exe'), path.join(appDir, 'sareea-dl-host.exe'));
const wire = applyFuses(exe);
fs.rmSync(stage, { recursive: true, force: true });
try {
  fs.rmdirSync(at('.tmp')); // only if empty
} catch {
  /* something else is staged: leave it */
}

// The extension on its own: <out>/extension (Load unpacked) and <out>/sareea-dl-extension.zip
const extOut = path.join(out, 'extension');
fs.rmSync(extOut, { recursive: true, force: true });
fs.cpSync(path.join(distDir, 'extension'), extOut, { recursive: true });
const zipFile = path.join(out, 'sareea-dl-extension.zip');
fs.rmSync(zipFile, { force: true });
const entries = zipDirectory(extOut, zipFile);
console.log(`extension -> ${extOut} and ${zipFile} (${entries} files)`);
console.log('fuses:', wire);
if (flavour === 'release') {
  // The release gate: the package must contain no test hook. Fails the packaging (non-zero exit) if one is found.
  const r = checkReleaseApp(appDir);
  if (!r.ok) {
    console.error(`release check FAIL: test hooks found in the release package
${describeFindings(r)}`);
    process.exit(1);
  }
  console.log(`release check PASS: no test hook strings in ${r.scanned.length} scanned items`);
} else {
  console.log('TEST flavour: contains the self-test and test hooks. Do not ship it.');
}
console.log(`packaged (${flavour}) ->`, exe);
