// Draws the Sareea DL icon from scratch (no image libraries) and writes
// assets/icon.png (256 px) and assets/icon.ico (16..256 px, PNG-compressed entries).
// Run: node scripts/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c;
  const table = (crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the artwork, in a 0..1 square -------------------------------------------------------------

function roundedRectCov(x, y, r) {
  // inside test for a rounded square covering 0.04..0.96
  const lo = 0.04;
  const hi = 0.96;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  return Math.hypot(x - cx, y - cy) <= r && x >= lo && x <= hi && y >= lo && y <= hi;
}

function inTriangle(px, py, a, b, c) {
  const d = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const p = [px, py];
  const d1 = d(p, a, b);
  const d2 = d(p, b, c);
  const d3 = d(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function inRoundBar(x, y, x0, y0, x1, y1) {
  const r = (y1 - y0) / 2;
  const cy = (y0 + y1) / 2;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function sample(x, y) {
  // returns [r,g,b,a] 0..255 for a point, or null when outside the tile
  if (!roundedRectCov(x, y, 0.22)) return null;
  // diagonal blue gradient
  const t = Math.min(1, Math.max(0, (x * 0.45 + y * 0.9) / 1.35));
  let col = [0x3b + (0x1e - 0x3b) * t, 0x82 + (0x3a - 0x82) * t, 0xf6 + (0xbc - 0xf6) * t];
  // soft highlight on the top edge
  const hl = Math.max(0, 0.16 - (y - 0.04)) / 0.16;
  col = col.map((c) => c + (255 - c) * 0.14 * hl);
  // white download arrow and tray
  const shaft = x >= 0.44 && x <= 0.56 && y >= 0.2 && y <= 0.5;
  const head = inTriangle(x, y, [0.26, 0.46], [0.74, 0.46], [0.5, 0.72]);
  const tray = inRoundBar(x, y, 0.24, 0.77, 0.76, 0.85);
  // two speed lines on the left of the shaft
  const s1 = inRoundBar(x, y, 0.16, 0.28, 0.34, 0.33);
  const s2 = inRoundBar(x, y, 0.2, 0.38, 0.34, 0.43);
  if (shaft || head || tray) return [255, 255, 255, 255];
  if (s1 || s2) return [255, 255, 255, 170];
  return [...col, 255];
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const n = size >= 64 ? 3 : 4; // supersampling grid per pixel
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const s = sample((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size);
          if (!s) continue;
          const al = s[3] / 255;
          r += s[0] * al; g += s[1] * al; b += s[2] * al; a += al;
        }
      }
      const total = n * n;
      const o = (py * size + px) * 4;
      if (a > 0) {
        buf[o] = Math.round(r / a);
        buf[o + 1] = Math.round(g / a);
        buf[o + 2] = Math.round(b / a);
        buf[o + 3] = Math.round((a / total) * 255);
      }
    }
  }
  return encodePng(size, size, buf);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => render(s));

// ICO: header, directory, then the PNG images
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = [];
sizes.forEach((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  dir.push(e);
});

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngs[pngs.length - 1]);
fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), Buffer.concat([header, ...dir, ...pngs]));
console.log('wrote assets/icon.png and assets/icon.ico', sizes.join(','));
