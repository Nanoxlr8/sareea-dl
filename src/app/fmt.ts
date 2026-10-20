/** Number, size, time formatting for the UI. Pure. Digits stay Western in every language. */
import type { Language } from './settings.ts';

const UNITS: Record<Language, string[]> = {
  en: ['B', 'KB', 'MB', 'GB', 'TB'],
  ar: ['بايت', 'ك.ب', 'م.ب', 'ج.ب', 'ت.ب'],
};
const PER_SEC: Record<Language, string> = { en: '/s', ar: '/ث' };

export function formatSize(n: number | null | undefined, lang: Language = 'en'): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.en.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${UNITS[lang][i]}`;
}

export function formatRate(bytesPerSec: number, lang: Language = 'en'): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  return formatSize(bytesPerSec, lang) + PER_SEC[lang];
}

/** mm:ss or h:mm:ss, empty when unknown. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** ISO-style local date and time: 2026-10-20 14:32. Empty for an invalid date. */
export function formatDateTime(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function percent(downloaded: number, size: number | null): number {
  if (size === null || size <= 0) return 0;
  return Math.max(0, Math.min(100, (downloaded / size) * 100));
}
