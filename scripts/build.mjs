// Bundles main, preload and renderer into dist/ with esbuild. No TypeScript runtime is needed at run time.
// Run: node scripts/build.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);

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
  console.log('build ok -> dist/');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAll();
}
