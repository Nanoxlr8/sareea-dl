// Bundles main, preload and renderer with esbuild. No TypeScript runtime is needed at run time.
//
// Two flavours (see README, Security model, "Build flavours"):
//   release  -> dist/       __SAREEA_TEST_HOOKS__ = false: no self-test, no test data folder, no test pipe name,
//                           and the host is compiled without TEST_HOOKS. This is what `npm run package` ships.
//   test     -> dist-test/  __SAREEA_TEST_HOOKS__ = true and the host compiled with /define:TEST_HOOKS. Used only by
//                           `npm start`, the self-test and the end-to-end test. Never shipped.
// Run: node scripts/build.mjs [--flavour=test]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHost } from './build-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);

/** The browser extension: two bundled scripts plus the static files. Output: dist/extension (loadable as-is). */
export async function buildExtension(outDir = at('dist')) {
  const out = path.join(outDir, 'extension');
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

export const FLAVOURS = {
  release: { dir: 'dist', hooks: false },
  test: { dir: 'dist-test', hooks: true },
};

/** The app itself (main, preload, renderer) into `outDir`, for one flavour. esbuild only, no host, no extension. */
export async function buildApp({ flavour = 'release', outDir } = {}) {
  const f = FLAVOURS[flavour];
  if (!f) throw new Error(`unknown build flavour: ${flavour}`);
  const dir = outDir ?? at(f.dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const node = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'warning',
    // false in the release build: esbuild removes every branch and import that only the test hooks use.
    define: { __SAREEA_TEST_HOOKS__: String(f.hooks) },
    // Syntax minification folds the constant, so `false ? helper() : null` and `if (false && ...)` disappear together
    // with the helpers only they used (names and whitespace are kept: the release bundle stays readable).
    minifySyntax: !f.hooks,
  };

  await build({ ...node, entryPoints: [at('src/main/main.ts')], outfile: path.join(dir, 'main.cjs'), loader: { '.png': 'binary' } });
  await build({ ...node, entryPoints: [at('src/main/preload.ts')], outfile: path.join(dir, 'preload.cjs') });
  await build({
    entryPoints: [at('src/renderer/main.ts')],
    outfile: path.join(dir, 'renderer', 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    legalComments: 'none',
    logLevel: 'warning',
  });
  fs.copyFileSync(at('src/renderer/index.html'), path.join(dir, 'renderer', 'index.html'));
  fs.copyFileSync(at('src/renderer/styles.css'), path.join(dir, 'renderer', 'styles.css'));
  return dir;
}

/** App, extension and host for one flavour: dist/ (release) or dist-test/ (test). */
export async function buildAll({ flavour = 'release' } = {}) {
  const f = FLAVOURS[flavour];
  if (!f) throw new Error(`unknown build flavour: ${flavour}`);
  const outDir = await buildApp({ flavour });
  await buildExtension(outDir);
  buildHost(path.join(outDir, 'host', 'sareea-dl-host.exe'), { testHooks: f.hooks });
  if (flavour === 'test') {
    // lets `electron dist-test` start the test flavour straight from the folder (npm start)
    const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
    fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'main.cjs' }, null, 2));
  }
  console.log(`build ok (${flavour} flavour) -> ${f.dir}/`);
}

export function flavourFromArgs(args) {
  const a = args.find((x) => x.startsWith('--flavour='));
  return a ? a.slice('--flavour='.length) : 'release';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAll({ flavour: flavourFromArgs(process.argv.slice(2)) });
}
