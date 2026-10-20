/**
 * Install and remove the browser integration: the host manifest file plus one registry value per
 * browser (HKCU, so no admin rights). Nothing here runs by itself: the Settings buttons call it.
 * `reg.exe` is run by absolute path with an argument array (no shell), and every path comes from the
 * app, never from the UI. The registry runner is injectable so the logic is tested without touching
 * the real registry.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSERS, hostManifestPath, REGISTRY_KEYS, serializeHostManifest } from '../app/browser-integration.ts';
import type { BrowserKind } from '../app/browser-integration.ts';

export interface RegResult {
  code: number;
  stdout: string;
}
export type RegRunner = (args: string[]) => Promise<RegResult>;

export function systemRegRunner(): RegRunner {
  const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  return (args) =>
    new Promise<RegResult>((resolve) => {
      execFile(reg, args, { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (err, stdout) => {
        // execFile reports a non-zero exit as err.code (a number); a failure to start has a string code.
        const exit = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code || 1) : 1) : 0;
        resolve({ code: exit, stdout: String(stdout ?? '') });
      });
    });
}

export type BrowserState = 'installed' | 'missing' | 'stale';
export type IntegrationState = Record<BrowserKind, BrowserState>;

/** Value of the key's default entry, or null when the key (or the value) does not exist. */
export function parseRegDefault(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(?:\(Default\)|\(Standard\)|<NO NAME>)\s+REG_SZ\s+(.*?)\s*$/i.exec(line);
    if (m) return m[1];
  }
  return null;
}

const same = (a: string, b: string): boolean => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

export async function integrationState(opts: { dataDir: string; run: RegRunner; browsers?: readonly BrowserKind[] }): Promise<IntegrationState> {
  const manifest = hostManifestPath(opts.dataDir);
  const out = { chrome: 'missing', edge: 'missing' } as IntegrationState;
  for (const b of opts.browsers ?? BROWSERS) {
    const r = await opts.run(['query', REGISTRY_KEYS[b], '/ve']);
    const value = r.code === 0 ? parseRegDefault(r.stdout) : null;
    out[b] = value === null ? 'missing' : same(value, manifest) ? 'installed' : 'stale';
  }
  return out;
}

export interface InstallOptions {
  /** The packaged app's exe: what the browser will start as the host. */
  exePath: string;
  dataDir: string;
  run: RegRunner;
  browsers?: readonly BrowserKind[];
}

export async function installIntegration(opts: InstallOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  const manifest = hostManifestPath(opts.dataDir);
  try {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, serializeHostManifest(opts.exePath), 'utf8');
  } catch (e) {
    return { ok: false, error: `could not write the host manifest (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  for (const b of opts.browsers ?? BROWSERS) {
    const r = await opts.run(['add', REGISTRY_KEYS[b], '/ve', '/t', 'REG_SZ', '/d', manifest, '/f']);
    if (r.code !== 0) return { ok: false, error: `could not register the host for ${b}` };
  }
  return { ok: true };
}

export async function removeIntegration(opts: { dataDir: string; run: RegRunner; browsers?: readonly BrowserKind[] }): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const b of opts.browsers ?? BROWSERS) {
    const q = await opts.run(['query', REGISTRY_KEYS[b]]);
    if (q.code !== 0) continue; // not there: nothing to remove
    const r = await opts.run(['delete', REGISTRY_KEYS[b], '/f']);
    if (r.code !== 0) return { ok: false, error: `could not remove the registration for ${b}` };
  }
  const manifest = hostManifestPath(opts.dataDir);
  try {
    fs.rmSync(manifest, { force: true });
    fs.rmdirSync(path.dirname(manifest));
  } catch {
    /* the folder may be missing or not empty: harmless */
  }
  return { ok: true };
}
