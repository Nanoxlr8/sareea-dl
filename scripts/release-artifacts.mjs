// Release artifacts (after: node scripts/package.mjs --out=release/build, and electron-builder --prepackaged for the setup exe).
//   node scripts/release-artifacts.mjs   -> release/SareeaDL-<v>-win-x64-portable.zip, copies the setup exe, writes SHA256SUMS.txt
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';
import { PORTABLE_MARKER } from '../src/app/portable.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = path.join(root, 'release');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appDir = path.join(rel, 'build', 'Sareea DL-win32-x64');
const extDir = path.join(rel, 'build', 'extension');
const stageParent = path.join(rel, 'stage-portable');
const top = `SareeaDL-${version}-win-x64-portable`;
const stage = path.join(stageParent, top);
fs.rmSync(stageParent, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(appDir, stage, { recursive: true });
fs.cpSync(extDir, path.join(stage, 'extension'), { recursive: true });
fs.writeFileSync(path.join(stage, PORTABLE_MARKER), 'Portable mode: while this file sits next to "Sareea DL.exe", settings and the download list are kept in the "data" folder beside it.\r\n');
fs.writeFileSync(
  path.join(stage, 'README.txt'),
  [
    `Sareea DL ${version} (portable, Windows 10/11 x64)`,
    '',
    '1. Run "Sareea DL.exe". Settings and the download list are kept in the "data" folder next to it',
    '   (because portable.txt is here). Delete portable.txt to use %APPDATA%\Sareea DL instead.',
    '2. Browser extension (Chrome or Edge): open chrome://extensions (or edge://extensions), turn on Developer mode,',
    '   choose "Load unpacked" and select the "extension" folder here. Then in Sareea DL open Settings and press',
    '   "Install browser integration".',
    '',
    'The build is not code-signed, so Windows SmartScreen may warn on first run.',
    '',
  ].join('\r\n'),
);
const zip = path.join(rel, `${top}.zip`);
fs.rmSync(zip, { force: true });
// zip with the top folder as the archive root
const n = zipDirectory(stageParent, zip);
fs.rmSync(stageParent, { recursive: true, force: true });
console.log(`portable zip: ${zip} (${n} files)`);

const setupName = `SareeaDL-${version}-win-x64-setup.exe`;
fs.copyFileSync(path.join(rel, 'installer-tmp', setupName), path.join(rel, setupName));
const lines = [setupName, `${top}.zip`].map((f) => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(rel, f))).digest('hex');
  return `${h}  ${f}`;
});
fs.writeFileSync(path.join(rel, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
