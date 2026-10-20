// Build, then package for Windows x64 into out/Sareea DL-win32-x64 (asar on, app icon) and
// harden the Electron binary by flipping its fuses. Run: npm run package
import { packager } from '@electron/packager';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build.mjs';
import { applyFuses } from './fuses.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const require = createRequire(import.meta.url);

await buildAll();

// Stage only what the app needs at run time: dist/ and a minimal package.json (no scripts, no dev tools).
const stage = at('.tmp', 'stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(at('dist'), path.join(stage, 'dist'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: 'dist/main.cjs', license: pkg.license }, null, 2),
);

const electronVersion = require('electron/package.json').version;
const out = at('out');
const [appDir] = await packager({
  dir: stage,
  out,
  name: 'Sareea DL',
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  asar: true,
  overwrite: true,
  prune: false,
  icon: at('assets', 'icon.ico'),
  appVersion: pkg.version,
  appCopyright: 'Sareea DL',
  win32metadata: { CompanyName: 'Sareea', FileDescription: 'Sareea DL download manager', ProductName: 'Sareea DL', InternalName: 'Sareea DL', OriginalFilename: 'Sareea DL.exe' },
});

const exe = path.join(appDir, 'Sareea DL.exe');
const wire = applyFuses(exe);
fs.rmSync(path.join(root, '.tmp'), { recursive: true, force: true });
console.log('fuses:', wire);
console.log('packaged ->', exe);
