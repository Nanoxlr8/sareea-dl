/** Settings model and validation. Pure. */
import path from 'node:path';

export type Theme = 'light' | 'dark' | 'system';
export type Language = 'en' | 'ar';

export interface Settings {
  /** Absolute folder. Downloads go here (plus a category subfolder when categorySubfolders is on). */
  defaultDir: string;
  categorySubfolders: boolean;
  /** Downloads running at once, 1..10. */
  maxConcurrent: number;
  /** Default connections per download, 1..16. */
  defaultConnections: number;
  /** Global speed limit in KiB/s, 0 = unlimited. */
  speedLimitKiBps: number;
  startWithWindows: boolean;
  theme: Theme;
  language: Language;
  /** Closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
  /** Offer to download http(s) links to downloadable files when they are copied. */
  clipboardWatch: boolean;
  /** Downloads sent by the browser extension start without showing the Add dialog. */
  browserAutoStart: boolean;
  notifyOnComplete: boolean;
}

export const LIMITS = {
  maxConcurrent: { min: 1, max: 10 },
  connections: { min: 1, max: 16 },
  speedLimitKiBps: { min: 0, max: 10_000_000 },
  pathLength: 1024,
} as const;

export function defaultSettings(userProfile: string): Settings {
  return {
    defaultDir: path.win32.join(userProfile, 'Downloads', 'Sareea'),
    categorySubfolders: true,
    maxConcurrent: 3,
    defaultConnections: 8,
    speedLimitKiBps: 0,
    startWithWindows: false,
    theme: 'system',
    language: 'en',
    closeToTray: true,
    clipboardWatch: false,
    browserAutoStart: false,
    notifyOnComplete: true,
  };
}

const KEYS: (keyof Settings)[] = [
  'defaultDir', 'categorySubfolders', 'maxConcurrent', 'defaultConnections', 'speedLimitKiBps', 'startWithWindows',
  'theme', 'language', 'closeToTray', 'clipboardWatch', 'browserAutoStart', 'notifyOnComplete',
];

export function isAbsoluteWindowsPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > LIMITS.pathLength) return false;
  if (p.includes('\0')) return false;
  if (p.startsWith('\\\\.\\') || p.startsWith('\\\\?\\')) return false; // device and extended paths
  if (/[<>:"|?*]/.test(p.slice(2))) return false; // also blocks alternate data streams (C:\x:stream)
  if (p.split(/[\\/]/).some((part) => part === '..')) return false;
  return path.win32.isAbsolute(p) && /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(p);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function checkField(key: keyof Settings, v: unknown): string | null {
  switch (key) {
    case 'defaultDir':
      return isAbsoluteWindowsPath(v) ? null : 'defaultDir must be an absolute Windows folder path';
    case 'categorySubfolders':
    case 'startWithWindows':
    case 'closeToTray':
    case 'clipboardWatch':
    case 'browserAutoStart':
    case 'notifyOnComplete':
      return typeof v === 'boolean' ? null : `${key} must be true or false`;
    case 'maxConcurrent':
      return isInt(v, LIMITS.maxConcurrent.min, LIMITS.maxConcurrent.max) ? null : `maxConcurrent must be an integer ${LIMITS.maxConcurrent.min}-${LIMITS.maxConcurrent.max}`;
    case 'defaultConnections':
      return isInt(v, LIMITS.connections.min, LIMITS.connections.max) ? null : `defaultConnections must be an integer ${LIMITS.connections.min}-${LIMITS.connections.max}`;
    case 'speedLimitKiBps':
      return isInt(v, LIMITS.speedLimitKiBps.min, LIMITS.speedLimitKiBps.max) ? null : 'speedLimitKiBps must be a non-negative integer';
    case 'theme':
      return v === 'light' || v === 'dark' || v === 'system' ? null : 'theme must be light, dark or system';
    case 'language':
      return v === 'en' || v === 'ar' ? null : 'language must be en or ar';
  }
}

export type PatchResult = { ok: true; value: Partial<Settings> } | { ok: false; error: string };

/** Strict validation of a settings change coming from the UI. Unknown keys and bad values are rejected. */
export function validateSettingsPatch(raw: unknown): PatchResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'settings must be an object' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(KEYS as string[]).includes(k)) return { ok: false, error: `unknown setting ${k}` };
    const err = checkField(k as keyof Settings, v);
    if (err) return { ok: false, error: err };
    out[k] = v;
  }
  return { ok: true, value: out as Partial<Settings> };
}

/** Lenient load of a settings file: every invalid or missing field falls back to its default. */
export function sanitizeLoadedSettings(raw: unknown, defaults: Settings): Settings {
  const out: Settings = { ...defaults };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const key of KEYS) {
    if (key in rec && checkField(key, rec[key]) === null) (out as unknown as Record<string, unknown>)[key] = rec[key];
  }
  return out;
}
