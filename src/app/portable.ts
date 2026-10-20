/**
 * Portable mode: if a file named portable.txt sits next to the exe, user data lives in a "data" folder beside the exe
 * instead of %APPDATA%\Sareea DL. Pure function so it can be tested without Electron.
 */
import path from 'node:path';

export const PORTABLE_MARKER = 'portable.txt';
export const PORTABLE_DATA_DIR = 'data';

export function resolveUserDataDir(opts: { exeDir: string; appDataDir: string; fileExists: (p: string) => boolean }): string {
  if (opts.fileExists(path.join(opts.exeDir, PORTABLE_MARKER))) return path.join(opts.exeDir, PORTABLE_DATA_DIR);
  return path.join(opts.appDataDir, 'Sareea DL');
}
