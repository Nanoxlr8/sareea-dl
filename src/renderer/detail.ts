/** The bottom detail panel: IDM-style segment blocks, per-connection bars, speed graph and transfer details. */
import type { DetailView, SegmentView, ViewItem } from '../app/api.ts';
import type { StringKey } from '../app/strings.ts';
import { formatDateTime, formatDuration, formatRate, formatSize, percent } from '../app/fmt.ts';
import type { Language } from '../app/settings.ts';

export interface DetailContext {
  t(key: StringKey, vars?: Record<string, string | number>): string;
  lang(): Language;
  statusLabel(item: ViewItem): string;
}

const MAX_LIST_ROWS = 32;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

export class DetailPanel {
  private readonly root = document.getElementById('detail') as HTMLElement;
  private readonly nameEl = document.getElementById('detailName') as HTMLElement;
  private readonly statusEl = document.getElementById('detailStatus') as HTMLElement;
  private readonly segCanvas = document.getElementById('segCanvas') as HTMLCanvasElement;
  private readonly speedCanvas = document.getElementById('speedCanvas') as HTMLCanvasElement;
  private readonly segList = document.getElementById('segList') as HTMLElement;
  private readonly info = document.getElementById('detailInfo') as HTMLElement;
  private readonly ctx: DetailContext;
  private item: ViewItem | null = null;
  private detail: DetailView | null = null;
  private readonly rows = new Map<string, { dt: HTMLElement; dd: HTMLElement }>();
  private readonly segRows: { row: HTMLElement; label: HTMLElement; fill: HTMLElement; pct: HTMLElement }[] = [];

  constructor(ctx: DetailContext) {
    this.ctx = ctx;
    window.addEventListener('resize', () => this.render());
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
    if (v) this.render();
  }

  setItem(item: ViewItem | null): void {
    if (item?.id !== this.item?.id) this.detail = null;
    this.item = item;
    this.render();
  }

  setDetail(d: DetailView): void {
    if (this.item && d.id === this.item.id) {
      this.detail = d;
      this.render();
    }
  }

  /** Re-translate labels after a language change. */
  relabel(): void {
    this.rows.clear();
    this.info.replaceChildren();
    this.render();
  }

  render(): void {
    if (this.root.hidden) return;
    const it = this.item;
    if (!it) {
      this.nameEl.textContent = '';
      this.statusEl.textContent = '';
      this.segList.replaceChildren();
      this.segRows.length = 0;
      this.clear(this.segCanvas, 40);
      this.clear(this.speedCanvas, 64);
      this.info.replaceChildren();
      this.rows.clear();
      return;
    }
    this.nameEl.textContent = it.name;
    this.nameEl.title = it.name;
    this.statusEl.textContent = this.ctx.statusLabel(it);
    this.statusEl.className = 'badge st-' + it.status;
    const segs = this.detail?.segments ?? [];
    this.drawSegments(segs, it.size);
    this.updateSegList(segs);
    this.drawSpeed(this.detail?.speedHistory ?? []);
    this.updateInfo(it);
  }

  // ------------------------------------------------------------- canvases

  private prepare(canvas: HTMLCanvasElement, cssH: number): { g: CanvasRenderingContext2D; w: number; h: number } | null {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(50, canvas.clientWidth || 300);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssH * dpr);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.scale(dpr, dpr);
    return { g, w, h: cssH };
  }

  private clear(canvas: HTMLCanvasElement, cssH: number): void {
    const p = this.prepare(canvas, cssH);
    if (!p) return;
    p.g.fillStyle = cssVar('--track');
    p.g.fillRect(0, 0, p.w, p.h);
  }

  private drawSegments(segs: SegmentView[], size: number | null): void {
    const p = this.prepare(this.segCanvas, 40);
    if (!p) return;
    const { g, w, h } = p;
    g.fillStyle = cssVar('--track');
    g.fillRect(0, 0, w, h);
    if (!size || size <= 0 || segs.length === 0) return;
    const cols = Math.max(10, Math.floor(w / 8));
    const cw = w / cols;
    const colors = Array.from({ length: 8 }, (_, i) => cssVar(`--seg-${i}`));
    for (let c = 0; c < cols; c++) {
      const a = (c * size) / cols;
      const b = ((c + 1) * size) / cols;
      let done = 0;
      let owner = 0;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const lo = Math.max(a, s.start);
        const hiAll = Math.min(b, s.end + 1);
        if (hiAll > lo && (a + b) / 2 >= s.start && (a + b) / 2 <= s.end + 1) owner = i;
        const hiDone = Math.min(b, Math.min(s.pos, s.end + 1));
        if (hiDone > lo) done += hiDone - lo;
      }
      const frac = Math.min(1, done / (b - a));
      if (frac <= 0) continue;
      g.fillStyle = colors[owner % 8];
      const fh = Math.max(2, Math.round(h * frac));
      g.fillRect(c * cw + 0.5, h - fh, Math.max(1, cw - 1), fh);
    }
    // thin separators where connections meet
    g.fillStyle = cssVar('--surface');
    for (let i = 1; i < segs.length; i++) {
      const x = Math.round((segs[i].start / size) * w);
      g.fillRect(x, 0, 1, h);
    }
  }

  private drawSpeed(hist: number[]): void {
    const p = this.prepare(this.speedCanvas, 64);
    if (!p) return;
    const { g, w, h } = p;
    g.fillStyle = cssVar('--track');
    g.fillRect(0, 0, w, h);
    if (hist.length < 2) return;
    const max = Math.max(...hist, 1);
    const step = w / Math.max(hist.length - 1, 1);
    g.beginPath();
    g.moveTo(0, h);
    hist.forEach((v, i) => g.lineTo(i * step, h - 4 - (v / max) * (h - 18)));
    g.lineTo((hist.length - 1) * step, h);
    g.closePath();
    g.globalAlpha = 0.25;
    g.fillStyle = cssVar('--accent');
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    hist.forEach((v, i) => {
      const y = h - 4 - (v / max) * (h - 18);
      if (i === 0) g.moveTo(0, y);
      else g.lineTo(i * step, y);
    });
    g.strokeStyle = cssVar('--accent');
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = cssVar('--muted');
    g.direction = 'ltr';
    g.font = '11px "Segoe UI", system-ui, sans-serif';
    g.textBaseline = 'top';
    g.fillText(formatRate(max, this.ctx.lang()), 6, 3);
  }

  // ---------------------------------------------------------------- lists

  private updateSegList(segs: SegmentView[]): void {
    const shown = segs.slice(0, MAX_LIST_ROWS);
    while (this.segRows.length < shown.length) {
      const row = el('div', 'seg-row');
      const label = el('span', 'seg-label');
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      bar.appendChild(fill);
      const pct = el('span', 'seg-pct');
      row.append(label, bar, pct);
      this.segList.appendChild(row);
      this.segRows.push({ row, label, fill, pct });
    }
    while (this.segRows.length > shown.length) this.segRows.pop()?.row.remove();
    shown.forEach((s, i) => {
      const r = this.segRows[i];
      const len = s.end - s.start + 1;
      const done = Math.max(0, Math.min(len, s.pos - s.start));
      const pct = len > 0 ? (done / len) * 100 : 100;
      const label = this.ctx.t('detail.segment', { n: i + 1 });
      if (r.label.textContent !== label) r.label.textContent = label;
      r.fill.className = `fill seg-c${i % 8}`;
      r.fill.style.width = `${pct.toFixed(1)}%`;
      r.pct.textContent = `${Math.floor(pct)}%`;
    });
  }

  private setRow(key: string, label: string, value: string, mono = false): void {
    let r = this.rows.get(key);
    if (!r) {
      r = { dt: el('dt'), dd: el('dd') };
      this.rows.set(key, r);
      this.info.append(r.dt, r.dd);
    }
    if (r.dt.textContent !== label) r.dt.textContent = label;
    if (r.dd.textContent !== value) r.dd.textContent = value;
    r.dd.title = value;
    r.dd.classList.toggle('mono', mono);
  }

  private dropRow(key: string): void {
    const r = this.rows.get(key);
    if (r) {
      r.dt.remove();
      r.dd.remove();
      this.rows.delete(key);
    }
  }

  private updateInfo(it: ViewItem): void {
    const { t } = this.ctx;
    const lang = this.ctx.lang();
    const pct = percent(it.downloaded, it.size);
    this.setRow('size', t('detail.size'), it.size !== null ? formatSize(it.size, lang) : t('detail.unknown'));
    this.setRow('done', t('detail.downloaded'), formatSize(it.downloaded, lang) || '0');
    if (it.size) this.setRow('pct', t('col.progress'), `${pct.toFixed(1)}%`);
    else this.dropRow('pct');
    this.setRow('speed', t('detail.speedNow'), it.status === 'downloading' ? formatRate(it.speed, lang) || '-' : '-');
    this.setRow('eta', t('detail.eta'), it.status === 'downloading' ? formatDuration(it.eta) || '-' : '-');
    this.setRow('conn', t('detail.connections'), String(it.connections));
    const warnings = this.detail?.warnings ?? [];
    if (it.size !== null && it.status !== 'queued') {
      const no = warnings.some((w) => /^(single-connection|not-resumable|ranges-ignored)/.test(w));
      this.setRow('resume', t('detail.resumable'), no ? t('detail.no') : t('detail.yes'));
    } else this.dropRow('resume');
    this.setRow('dir', t('detail.saveTo'), it.path ?? it.dir, true);
    this.setRow('url', t('detail.url'), it.url, true);
    this.setRow('added', t('detail.added'), formatDateTime(it.createdAt));
    if (it.error) this.setRow('error', t('detail.error'), it.error);
    else this.dropRow('error');
    if (warnings.length > 0) this.setRow('warn', t('detail.warnings'), warnings.join('\n'));
    else this.dropRow('warn');
    if (it.hadHeaders) this.setRow('hdr', t('detail.headers'), t('detail.yes'));
    else this.dropRow('hdr');
  }
}
