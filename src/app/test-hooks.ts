/**
 * Test hooks of the desktop app. Pure helpers, no Electron.
 *
 * These exist only for the automated tests (`--self-test`, the end-to-end browser test). They are compiled into
 * the TEST flavour of the app only: src/main/main.ts reaches them exclusively through `__SAREEA_TEST_HOOKS__`
 * (an esbuild `define`, false in the release build), so esbuild removes this whole module, and every string in
 * it, from the release bundle. scripts/check-release.mjs fails the release package if any hook string is found.
 *
 * Hook inputs (all of them are control surface and must never exist in a release):
 *   SAREEA_DL_TEST_DIR   absolute folder: the app keeps its data there and uses its own pipe name
 *   --self-test          run the built-in end-to-end proof in a throw-away profile, then quit
 *   --self-test-out=F    also write the self-test report to file F
 *   --screenshot-dir=D   with --self-test: save screenshots and show the window
 *   --self-test-showcase=D  stage a few downloads and save README screenshots into D (own data folder, never the real profile)
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function testDirFromEnv(env: Record<string, string | undefined>): string | null {
  const d = env.SAREEA_DL_TEST_DIR;
  return d && path.win32.isAbsolute(d) ? d : null;
}

export function pipeSuffixForTestDir(dir: string | null): string {
  if (!dir) return '';
  return '-test-' + createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 10);
}

export interface TestMode {
  selfTest: boolean;
  selfTestOut: string | null;
  screenshotDir: string | null;
  /** Output folder of the screenshot showcase (src/main/showcase.ts). */
  showcaseDir: string | null;
  /** Data folder from SAREEA_DL_TEST_DIR (ignored by a self-test run, which gets a throw-away temp folder). */
  testDir: string | null;
  /** The userData folder to use instead of the real one: the throw-away folder of a self-test, or testDir. */
  userData: string | null;
  /** Suffix for the bridge pipe name: own pipe per self-test run / per test folder. */
  pipeSuffix: string;
}

export function readTestMode(argv: readonly string[], env: Record<string, string | undefined>, pid: number): TestMode {
  const value = (name: string): string | null => {
    const a = argv.find((x) => x.startsWith(name + '='));
    return a ? a.slice(name.length + 1) : null;
  };
  const selfTest = argv.includes('--self-test');
  const showcaseDir = value('--self-test-showcase');
  const testDir = testDirFromEnv(env);
  return {
    selfTest,
    selfTestOut: value('--self-test-out'),
    screenshotDir: value('--screenshot-dir'),
    showcaseDir,
    testDir,
    // the showcase never falls back to the real profile: no test folder means a throw-away temp folder
    userData: selfTest ? path.join(os.tmpdir(), `sareea-selftest-${pid}`) : showcaseDir ? (testDir ?? path.join(os.tmpdir(), `sareea-showcase-${pid}`)) : testDir,
    pipeSuffix: selfTest ? `-selftest-${pid}` : showcaseDir && !testDir ? `-showcase-${pid}` : pipeSuffixForTestDir(testDir),
  };
}
