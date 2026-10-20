// Bundles main, preload and renderer into dist/ with esbuild. No TypeScript runtime is needed at run time.
// Run: node scripts/build.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHost } from './build-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);

/** The browser extension: two bundled scripts plus the static files. Output: dist/extension (loadable as-is). */
export async function buildExtension() {
  const out = at('dist', 'extension');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const common = {
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome110',
    legalComments: 'none',
    logLevel: 'warning',
  };
  await build({ ...common, entryPoints: [at('src/extension/background.ts')], outfile: path.join(out, 'background.js') });
  await build({ ...common, entryPoints: [at('src/extension/popup.ts')], outfile: path.join(out, 'popup.js') });
  for (const f of ['manifest.json', 'popup.html', 'popup.css']) fs.copyFileSync(at('extension', f), path.join(out, f));
  fs.cpSync(at('extension', 'icons'), path.join(out, 'icons'), { recursive: true });
}

export async function buildAll() {
  fs.rmSync(at('dist'), { recursive: true, force: true });

  const node = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'warning',
  };

  await build({ ...node, entryPoints: [at('src/main/main.ts')], outfile: at('dist/main.cjs'), loader: { '.png': 'binary' } });
  await build({ ...node, entryPoints: [at('src/main/preload.ts')], outfile: at('dist/preload.cjs') });
  await build({
    entryPoints: [at('src/renderer/main.ts')],
    outfile: at('dist/renderer/app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    legalComments: 'none',
    logLevel: 'warning',
  });

  fs.copyFileSync(at('src/renderer/index.html'), at('dist/renderer/index.html'));
  fs.copyFileSync(at('src/renderer/styles.css'), at('dist/renderer/styles.css'));
  await buildExtension();
  buildHost(at('dist', 'host', 'sareea-dl-host.exe'));
  console.log('build ok -> dist/');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAll();
}
