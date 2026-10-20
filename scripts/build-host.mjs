// Compiles the native-messaging host (host/SareeaHost.cs) with csc.exe, the C# compiler that is part of the
// .NET Framework 4 on every Windows 10/11 PC (no SDK, no Visual Studio, no Node needed to RUN the result).
// The allowed extension origin and the app exe name are generated from src/app/browser-integration.ts so the
// host and the app can never disagree.
// Run: node scripts/build-host.mjs [out.exe]      (default: dist/host/sareea-dl-host.exe)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_ORIGIN, APP_EXE_NAME } from '../src/app/browser-integration.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findCsc() {
  const win = process.env.SystemRoot ?? 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('csc.exe (the C# compiler of the .NET Framework 4) was not found under %SystemRoot%\\Microsoft.NET');
}

export function generatedSource(version) {
  const s = (v) => JSON.stringify(v); // a C# string literal for plain ASCII text
  return [
    'using System.Reflection;',
    `[assembly: AssemblyTitle("Sareea DL browser host")]`,
    `[assembly: AssemblyDescription("Native messaging host that hands browser downloads to Sareea DL")]`,
    `[assembly: AssemblyCompany("Sareea")]`,
    `[assembly: AssemblyProduct("Sareea DL")]`,
    `[assembly: AssemblyVersion(${s(version)})]`,
    `[assembly: AssemblyFileVersion(${s(version)})]`,
    'static class Generated',
    '{',
    `    public const string AllowedOrigin = ${s(ALLOWED_ORIGIN)};`,
    `    public const string AppExeName = ${s(APP_EXE_NAME)};`,
    '}',
    '',
  ].join('\r\n');
}

/** Compile the host to `outFile`. Returns the path. Throws with the compiler's output on failure. */
export function buildHost(outFile = path.join(root, 'dist', 'host', 'sareea-dl-host.exe')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = `${pkg.version}.0`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sareea-host-build-'));
  try {
    const generated = path.join(tmp, 'Generated.cs');
    fs.writeFileSync(generated, generatedSource(version));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.rmSync(outFile, { force: true });
    const args = [
      '/nologo', '/target:winexe', '/optimize+', '/debug-', '/platform:anycpu', '/warnaserror+',
      `/out:${outFile}`, `/win32icon:${path.join(root, 'assets', 'icon.ico')}`,
      '/r:System.dll', '/r:System.Web.Extensions.dll',
      path.join(root, 'host', 'SareeaHost.cs'), generated,
    ];
    const r = spawnSync(findCsc(), args, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !fs.existsSync(outFile)) {
      throw new Error('host build failed:\n' + (r.stdout ?? '') + (r.stderr ?? ''));
    }
    return outFile;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildHost(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log('host build ok ->', out, `(${fs.statSync(out).size} bytes)`);
}
