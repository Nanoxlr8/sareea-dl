import fs from 'node:fs';
import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const MAX_LEN = 200;

function splitExt(name: string): { stem: string; ext: string } {
  let ext = path.extname(name);
  if (ext.length > 20) ext = '';
  let stem = name.slice(0, name.length - ext.length);
  // keep double extensions such as .tar.gz together
  if (ext && /\.tar$/i.test(stem)) {
    ext = stem.slice(-4) + ext;
    stem = stem.slice(0, -4);
  }
  return { stem, ext };
}

/** "name.ext" -> "name (n).ext" */
export function numberedName(name: string, n: number): string {
  const { stem, ext } = splitExt(name);
  return `${stem} (${n})${ext}`;
}

/**
 * Turn any string into a safe single Windows file name component.
 * Strips directories and "..", control chars, <>:"/\|?*, trailing dots/spaces,
 * reserved device names, and caps the length (extension is kept).
 */
export function sanitizeFileName(input: string, fallback = 'download'): string {
  let name = String(input ?? '').normalize('NFC');
  const parts = name.split(/[\\/]+/).filter((p) => p.length > 0);
  name = parts.length ? parts[parts.length - 1] : '';
  name = name.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '');
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/\.{2,}/g, '.');
  name = name.replace(/^\s+/, '').replace(/[. ]+$/, '');
  if (name === '') return fallback === 'download' || fallback === '' ? 'download' : sanitizeFileName(fallback, 'download');
  const base = name.split('.')[0].trim();
  if (RESERVED.test(base)) name = '_' + name;
  if (name.length > MAX_LEN) {
    const { stem, ext } = splitExt(name);
    let cut = stem.slice(0, Math.max(1, MAX_LEN - ext.length));
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not split a surrogate pair
    name = (cut.replace(/[. ]+$/, '') || 'download') + ext;
  }
  return name;
}

/** First name in the series name, "name (1).ext", "name (2).ext", ... that does not exist in dir. */
export function uniqueName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  for (let i = 1; ; i++) {
    const candidate = numberedName(name, i);
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

function fixUtf8Mojibake(s: string): string {
  // Node decodes header bytes as latin1; servers that send raw UTF-8 arrive garbled.
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  return fixed.includes('�') ? s : fixed;
}

function pctDecodeBytes(s: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(s[i], 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

/** Extract the file name from a Content-Disposition header (RFC 6266 / 5987). Returns null if absent. */
export function parseContentDisposition(value: string | undefined | null): string | null {
  if (!value) return null;
  const params = new Map<string, string>();
  const re = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const key = m[1].toLowerCase();
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!params.has(key)) params.set(key, v);
  }
  const star = params.get('filename*');
  if (star) {
    const parsed = /^([^']*)'[^']*'(.*)$/.exec(star);
    if (parsed) {
      const charset = parsed[1].toLowerCase();
      const bytes = pctDecodeBytes(parsed[2]);
      try {
        if (charset === 'utf-8' || charset === 'utf8' || charset === '') {
          const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (s) return s;
        } else if (charset === 'iso-8859-1' || charset === 'latin1') {
          const s = bytes.toString('latin1');
          if (s) return s;
        }
      } catch {
        /* fall through to plain filename */
      }
    }
  }
  let plain = params.get('filename');
  if (plain) {
    if (/%[0-9a-fA-F]{2}/.test(plain)) {
      try {
        plain = decodeURIComponent(plain);
      } catch {
        /* keep as is */
      }
    }
    return fixUtf8Mojibake(plain);
  }
  return null;
}

/** Last path segment of a URL, percent-decoded. Null when the path has no usable name. */
export function fileNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length) return null;
    const last = segs[segs.length - 1];
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return null;
  }
}
