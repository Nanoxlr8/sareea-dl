/**
 * Renderer: the window UI. Runs sandboxed with no Node access; everything it can do goes through
 * window.sareea (see src/main/preload.ts). Text from the engine or the network is only ever put on
 * the page with textContent, never as markup.
 */
import type { AddPrefill, ItemsBatch, SareeaApi, ToastMessage, ViewItem } from '../app/api.ts';
import { categoryOf, subfolderFor } from '../app/categories.ts';
import type { CategoryFilter } from '../app/categories.ts';
import { formatDateTime, formatRate, formatSize, formatDuration, percent } from '../app/fmt.ts';
import type { Language, Settings } from '../app/settings.ts';
import { isRtl, translate } from '../app/strings.ts';
import type { StringKey } from '../app/strings.ts';
import { DetailPanel } from './detail.ts';
import { icon } from './icons.ts';

declare global {
  interface Window {
    sareea: SareeaApi;
  }
}

const api = window.sareea;

// ------------------------------------------------------------------ helpers

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing element #' + id);
  return e as T;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let settings: Settings;
let lang: Language = 'en';
let version = '';

function t(key: StringKey, vars?: Record<string, string | number>): string {
  return translate(lang, key, vars);
}

function urlNameGuess(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

function isHttpUrl(s: string): boolean {
  if (/\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

function statusLabel(it: ViewItem): string {
  if (it.held) return t('status.held');
  return t(('status.' + it.status) as StringKey);
}

const ACTIVE_STATES = ['queued', 'probing', 'downloading', 'verifying'];
const isActive = (it: ViewItem) => ACTIVE_STATES.includes(it.status) && !it.held;
const canResume = (it: ViewItem) => it.status === 'paused' || it.status === 'error' || it.status === 'cancelled';

// -------------------------------------------------------------------- state

const items = new Map<string, ViewItem>();
const selected = new Set<string>();
let anchorId: string | null = null;
let filter: CategoryFilter = 'all';
let sortCol = 'added';
let sortDir: 1 | -1 = -1;
let visibleOrder: string[] = [];

interface RowRefs {
  tr: HTMLTableRowElement;
  name: HTMLElement;
  ico: HTMLElement;
  size: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  speed: HTMLElement;
  eta: HTMLElement;
  status: HTMLElement;
  added: HTMLElement;
  cache: Record<string, string>;
  cat: string;
}
const rows = new Map<string, RowRefs>();
const tbody = $('rows');

// --------------------------------------------------------------- i18n / DOM

function applyI18n(): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl(lang) ? 'rtl' : 'ltr';
  document.title = t('app.name');
  for (const e of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const text = t(e.dataset.i18n as StringKey);
    const ic = e.dataset.icon;
    if (ic) {
      e.replaceChildren(icon(ic), h('span', 'lbl', text));
    } else {
      e.textContent = text;
    }
  }
  for (const e of document.querySelectorAll<HTMLElement>('[data-icon]:not([data-i18n])')) {
    e.replaceChildren(icon(e.dataset.icon as string));
  }
  for (const e of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const text = t(e.dataset.i18nTitle as StringKey);
    e.title = text;
    e.setAttribute('aria-label', text);
  }
  for (const e of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    e.placeholder = t(e.dataset.i18nPlaceholder as StringKey);
  }
  $('aboutLine').textContent = t('settings.about', { version });
}

// ------------------------------------------------------------------- toasts

function toast(kind: 'info' | 'error' | 'success', text: string): void {
  const box = $('toasts');
  const d = h('div', 'toast ' + kind, text);
  box.appendChild(d);
  while (box.children.length > 4) box.firstElementChild?.remove();
  setTimeout(() => d.remove(), kind === 'error' ? 7000 : 3500);
}

function errorToast(error: string): void {
  if (error === 'duplicate') return toast('info', t('toast.duplicate'));
  if (error === 'file-missing') return toast('error', t('toast.fileMissing'));
  if (error === 'cancelled') return;
  toast('error', t('toast.error', { msg: error }));
}

// ------------------------------------------------------------ confirm dialog

function confirmBox(title: string, text: string, okLabel: string): Promise<boolean> {
  const dlg = $<HTMLDialogElement>('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmYes').textContent = okLabel;
  return new Promise<boolean>((resolve) => {
    const done = (v: boolean) => {
      $('confirmYes').onclick = null;
      $('confirmNo').onclick = null;
      dlg.oncancel = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    dlg.oncancel = (e) => {
      e.preventDefault();
      done(false);
    };
    dlg.showModal();
    $('confirmNo').focus();
  });
}

// ------------------------------------------------------------- category bar

const FILTERS: CategoryFilter[] = ['all', 'compressed', 'documents', 'music', 'programs', 'video', 'unfinished', 'finished'];
const catItems = new Map<CategoryFilter, { li: HTMLElement; count: HTMLElement; label: HTMLElement }>();

function buildSidebar(): void {
  const ul = $('categories');
  ul.replaceChildren();
  catItems.clear();
  for (const f of FILTERS) {
    const li = h('li');
    li.dataset.filter = f;
    li.tabIndex = 0;
    const label = h('span', 'cat-label');
    const count = h('span', 'cat-count');
    li.append(icon(f === 'all' ? 'all' : f, 18), label, count);
    li.addEventListener('click', () => setFilter(f));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setFilter(f);
      }
    });
    ul.appendChild(li);
    catItems.set(f, { li, count, label });
  }
  relabelSidebar();
}

function relabelSidebar(): void {
  for (const [f, c] of catItems) c.label.textContent = t(('cat.' + f) as StringKey);
}

function setFilter(f: CategoryFilter): void {
  filter = f;
  queueRender();
}

function matches(f: CategoryFilter, it: ViewItem): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'finished':
      return it.status === 'done';
    case 'unfinished':
      return it.status !== 'done';
    default:
      return it.category === f;
  }
}

// --------------------------------------------------------------------- list

function cmpItems(a: ViewItem, b: ViewItem): number {
  let r = 0;
  switch (sortCol) {
    case 'name':
      r = a.name.localeCompare(b.name, lang);
      break;
    case 'size':
      r = (a.size ?? -1) - (b.size ?? -1);
      break;
    case 'progress':
    case 'pct':
      r = percent(a.downloaded, a.size) - percent(b.downloaded, b.size);
      break;
    case 'speed':
      r = a.speed - b.speed;
      break;
    case 'eta':
      r = (a.eta ?? Infinity) - (b.eta ?? Infinity);
      break;
    case 'status':
      r = statusLabel(a).localeCompare(statusLabel(b), lang);
      break;
    default:
      r = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  }
  if (r === 0) r = a.id < b.id ? -1 : 1;
  return r * sortDir;
}

function makeRow(id: string): RowRefs {
  const tr = document.createElement('tr');
  tr.dataset.id = id;
  const tdName = h('td', 'c-name');
  const ico = h('span', 'ico');
  const name = h('span', 'nm');
  tdName.append(ico, name);
  const size = h('td', 'num');
  const tdBar = h('td', 'c-bar');
  const bar = h('div', 'bar');
  const fill = h('div', 'fill');
  bar.appendChild(fill);
  tdBar.appendChild(bar);
  const pct = h('td', 'num');
  const speed = h('td', 'num');
  const eta = h('td', 'num');
  const status = h('td', 'status');
  const added = h('td', 'num dim');
  tr.append(tdName, size, tdBar, pct, speed, eta, status, added);
  return { tr, name, ico, size, fill, pct, speed, eta, status, added, cache: {}, cat: '' };
}

function setText(r: RowRefs, key: string, el: HTMLElement, value: string, title?: string): void {
  const sig = value + '\u0000' + (title ?? '');
  if (r.cache[key] === sig) return;
  r.cache[key] = sig;
  el.textContent = value;
  if (title !== undefined) el.title = title;
}

function updateRow(it: ViewItem, r: RowRefs): void {
  setText(r, 'name', r.name, it.name, it.name);
  if (r.cat !== it.category) {
    r.cat = it.category;
    r.ico.replaceChildren(icon(it.category, 16));
  }
  setText(r, 'size', r.size, it.size !== null ? formatSize(it.size, lang) : '');
  const p = it.status === 'done' ? 100 : percent(it.downloaded, it.size);
  const w = p.toFixed(1) + '%';
  if (r.cache.w !== w) {
    r.cache.w = w;
    r.fill.style.width = w;
  }
  setText(r, 'pct', r.pct, it.size !== null || it.status === 'done' ? (it.status === 'done' ? '100%' : p.toFixed(1) + '%') : '');
  const live = it.status === 'downloading';
  setText(r, 'speed', r.speed, live ? formatRate(it.speed, lang) : '');
  setText(r, 'eta', r.eta, live ? formatDuration(it.eta) : '');
  setText(r, 'status', r.status, statusLabel(it), it.error ?? '');
  setText(r, 'added', r.added, formatDateTime(it.createdAt));
  const cls = 'st-' + (it.held ? 'held' : it.status) + (selected.has(it.id) ? ' sel' : '');
  if (r.cache.cls !== cls) {
    r.cache.cls = cls;
    r.tr.className = cls;
  }
}

let renderQueued = false;
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    renderList();
  }, 0);
}

function renderList(): void {
  const visible = [...items.values()].filter((it) => matches(filter, it)).sort(cmpItems);
  visibleOrder = visible.map((i) => i.id);
  const keep = new Set(visibleOrder);
  for (const [id, r] of rows) {
    if (!keep.has(id)) {
      r.tr.remove();
      rows.delete(id);
    }
  }
  visible.forEach((it, i) => {
    let r = rows.get(it.id);
    if (!r) {
      r = makeRow(it.id);
      rows.set(it.id, r);
    }
    updateRow(it, r);
    if (tbody.children[i] !== r.tr) tbody.insertBefore(r.tr, tbody.children[i] ?? null);
  });
  // selection may refer to rows that are gone
  for (const id of [...selected]) if (!items.has(id)) selected.delete(id);

  for (const [f, c] of catItems) {
    const n = [...items.values()].filter((it) => matches(f, it)).length;
    c.count.textContent = n > 0 ? String(n) : '';
    c.li.classList.toggle('active', f === filter);
  }
  for (const th of document.querySelectorAll<HTMLElement>('#list th')) {
    th.classList.toggle('sorted', th.dataset.col === sortCol);
    th.classList.toggle('desc', th.dataset.col === sortCol && sortDir === -1);
  }
  const empty = $('empty');
  empty.hidden = visible.length > 0;
  $('emptyText').textContent = items.size === 0 ? t('empty.text') : t('empty.filtered');
  updateStatusBar();
  updateToolbar();
}

function updateStatusBar(): void {
  const all = [...items.values()];
  const active = all.filter((i) => i.status === 'downloading').length;
  const speed = all.reduce((s, i) => s + (i.status === 'downloading' ? i.speed : 0), 0);
  $('statusLeft').textContent = `${t('bar.count', { n: all.length })}  |  ${t('bar.active', { n: active })}`;
  const limit = settings.speedLimitKiBps > 0 ? t('bar.limit', { v: formatRate(settings.speedLimitKiBps * 1024, lang) }) : t('bar.unlimited');
  $('statusRight').textContent = `${speed > 0 ? formatRate(speed, lang) + '  |  ' : ''}${limit}`;
}

// ---------------------------------------------------------------- selection

function selectedItems(): ViewItem[] {
  return [...selected].map((id) => items.get(id)).filter((x): x is ViewItem => !!x);
}

function setSelection(ids: string[]): void {
  selected.clear();
  for (const id of ids) selected.add(id);
  for (const [id, r] of rows) r.tr.classList.toggle('sel', selected.has(id));
  updateToolbar();
  syncDetail();
}

function updateToolbar(): void {
  const sel = selectedItems();
  ($('btnResume') as HTMLButtonElement).disabled = !sel.some(canResume);
  ($('btnPause') as HTMLButtonElement).disabled = !sel.some(isActive);
  ($('btnDelete') as HTMLButtonElement).disabled = sel.length === 0;
  ($('btnDeleteFile') as HTMLButtonElement).disabled = sel.length === 0;
}

let watchedId: string | null = null;
let detail: DetailPanel;

function syncDetail(): void {
  const sel = selectedItems();
  const one = sel.length === 1 ? sel[0] : null;
  const want = detail.visible && one ? one.id : null;
  if (want !== watchedId) {
    watchedId = want;
    void api.watch(want);
  }
  detail.setItem(detail.visible ? one : null);
}

function toggleDetail(show?: boolean): void {
  const v = show ?? !detail.visible;
  detail.setVisible(v);
  $('btnDetails').classList.toggle('on', v);
  syncDetail();
}

tbody.addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest('tr');
  if (!tr) return;
  const id = tr.dataset.id as string;
  if (e.shiftKey && anchorId && visibleOrder.includes(anchorId)) {
    const a = visibleOrder.indexOf(anchorId);
    const b = visibleOrder.indexOf(id);
    setSelection(visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e.ctrlKey || e.metaKey) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    anchorId = id;
    setSelection([...next]);
  } else {
    anchorId = id;
    setSelection([id]);
  }
});

tbody.addEventListener('dblclick', (e) => {
  const tr = (e.target as HTMLElement).closest('tr');
  if (!tr) return;
  const it = items.get(tr.dataset.id as string);
  if (!it) return;
  if (it.status === 'done') void doOpen(it.id);
  else toggleDetail(true);
});

$('tableWrap').addEventListener('click', (e) => {
  if (e.target === $('tableWrap') || e.target === $('empty')) setSelection([]);
});

for (const th of document.querySelectorAll<HTMLElement>('#list th')) {
  th.addEventListener('click', () => {
    const col = th.dataset.col as string;
    if (sortCol === col) sortDir = sortDir === 1 ? -1 : 1;
    else {
      sortCol = col;
      sortDir = col === 'name' || col === 'status' ? 1 : -1;
    }
    queueRender();
  });
}

// ------------------------------------------------------------------ actions

async function run(p: Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
  const r = await p;
  if (!r.ok) {
    errorToast(r.error ?? 'error');
    return false;
  }
  return true;
}

const selIds = () => [...selected];

async function doOpen(id: string): Promise<void> {
  await run(api.openFile(id));
}

async function doDelete(withFile: boolean): Promise<void> {
  const ids = selIds();
  if (ids.length === 0) return;
  const ok = await confirmBox(
    withFile ? t('confirm.deleteFileTitle') : t('confirm.deleteTitle'),
    withFile ? t('confirm.deleteFileText', { n: ids.length }) : t('confirm.deleteText', { n: ids.length }),
    withFile ? t('confirm.deleteFileBtn') : t('confirm.deleteBtn'),
  );
  if (!ok) return;
  await run(api.remove({ ids, deleteFile: withFile }));
}

$('btnAdd').addEventListener('click', () => void openAdd());
$('btnResume').addEventListener('click', () => void run(api.resume(selectedItems().filter(canResume).map((i) => i.id))));
$('btnPause').addEventListener('click', () => void run(api.pause(selectedItems().filter(isActive).map((i) => i.id))));
$('btnDelete').addEventListener('click', () => void doDelete(false));
$('btnDeleteFile').addEventListener('click', () => void doDelete(true));
$('btnStartQueue').addEventListener('click', () => void run(api.startQueue()));
$('btnStopQueue').addEventListener('click', () => void run(api.stopQueue()));
$('btnSettings').addEventListener('click', () => openSettings());
$('btnDetails').addEventListener('click', () => toggleDetail());
$('btnDetailClose').addEventListener('click', () => toggleDetail(false));

// -------------------------------------------------------------- context menu

const menu = $('menu');

function hideMenu(): void {
  menu.hidden = true;
  menu.replaceChildren();
}

interface MenuEntry {
  label: string;
  icon: string;
  disabled?: boolean;
  danger?: boolean;
  action: () => void;
}

function showMenu(x: number, y: number): void {
  const sel = selectedItems();
  if (sel.length === 0) return;
  const one = sel.length === 1 ? sel[0] : null;
  const groups: MenuEntry[][] = [
    [
      { label: t('ctx.open'), icon: 'open', disabled: !(one && one.status === 'done'), action: () => one && void doOpen(one.id) },
      { label: t('ctx.openFolder'), icon: 'folder', disabled: !one, action: () => one && void run(api.openFolder(one.id)) },
      {
        label: t('ctx.copyLink'), icon: 'copy', disabled: !one,
        action: () => one && void run(api.copyLink(one.id)).then((ok) => ok && toast('success', t('toast.copied'))),
      },
    ],
    [
      { label: t('ctx.pause'), icon: 'pause', disabled: !sel.some(isActive), action: () => void run(api.pause(sel.filter(isActive).map((i) => i.id))) },
      { label: t('ctx.resume'), icon: 'play', disabled: !sel.some(canResume), action: () => void run(api.resume(sel.filter(canResume).map((i) => i.id))) },
      { label: t('ctx.redownload'), icon: 'redo', action: () => void run(api.redownload(sel.map((i) => i.id))) },
      { label: t('ctx.details'), icon: 'panel', disabled: !one, action: () => toggleDetail(true) },
    ],
    [
      { label: t('ctx.delete'), icon: 'trash', action: () => void doDelete(false) },
      { label: t('ctx.deleteFile'), icon: 'trashx', danger: true, action: () => void doDelete(true) },
    ],
  ];
  menu.replaceChildren();
  groups.forEach((g, gi) => {
    if (gi > 0) menu.appendChild(h('div', 'menu-sep'));
    for (const m of g) {
      const b = h('button', 'menu-item' + (m.danger ? ' danger' : ''));
      b.type = 'button';
      b.disabled = !!m.disabled;
      b.setAttribute('role', 'menuitem');
      b.append(icon(m.icon, 16), h('span', undefined, m.label));
      b.addEventListener('click', () => {
        hideMenu();
        m.action();
      });
      menu.appendChild(b);
    }
  });
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

tbody.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const tr = (e.target as HTMLElement).closest('tr');
  if (!tr) return;
  const id = tr.dataset.id as string;
  if (!selected.has(id)) {
    anchorId = id;
    setSelection([id]);
  }
  showMenu(e.clientX, e.clientY);
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) hideMenu();
});
window.addEventListener('blur', hideMenu);
document.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('tbody')) e.preventDefault();
});

// --------------------------------------------------------------- add dialog

const addDlg = $<HTMLDialogElement>('addDialog');
const addUrl = $<HTMLInputElement>('addUrl');
const addName = $<HTMLInputElement>('addName');
const addFolder = $<HTMLInputElement>('addFolder');
const addConn = $<HTMLInputElement>('addConn');
const addStart = $<HTMLButtonElement>('addStart');
const addQueue = $<HTMLButtonElement>('addQueue');

const addState = {
  dirOverride: null as string | null,
  bridgeToken: null as string | null,
  prefillUrl: null as string | null,
  nameEdited: false,
  probedName: '',
  probeSeq: 0,
  probeTimer: 0 as number,
  busy: false,
};
const pendingPrefills: AddPrefill[] = [];

function folderPreview(): string {
  if (addState.dirOverride) return addState.dirOverride;
  const base = settings.defaultDir;
  if (!settings.categorySubfolders) return base;
  const name = addName.value.trim() || addState.probedName || urlNameGuess(addUrl.value.trim());
  return base.replace(/[\\/]+$/, '') + '\\' + subfolderFor(categoryOf(name));
}

function refreshAddButtons(): void {
  const ok = isHttpUrl(addUrl.value.trim()) && !addState.busy;
  addStart.disabled = !ok;
  addQueue.disabled = !ok;
  addFolder.value = folderPreview();
  $('addFolderReset').hidden = addState.dirOverride === null;
  $('addConnOut').textContent = addConn.value;
}

function setProbeLine(kind: 'busy' | 'ok' | 'bad' | 'none', text = ''): void {
  const box = $('addInfo');
  box.hidden = kind === 'none';
  box.className = 'probe ' + kind;
  $('probeText').textContent = text;
  $('probeIcon').replaceChildren(icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'warn' : 'download', 16));
}

async function runProbe(): Promise<void> {
  const url = addUrl.value.trim();
  const seq = ++addState.probeSeq;
  if (!isHttpUrl(url)) {
    setProbeLine(url ? 'bad' : 'none', url ? t('add.invalidUrl') : '');
    refreshAddButtons();
    return;
  }
  setProbeLine('busy', t('add.probing'));
  const token = url === addState.prefillUrl ? addState.bridgeToken : null;
  const r = await api.probe({ url, bridgeToken: token });
  if (seq !== addState.probeSeq) return;
  if (!r.ok) {
    setProbeLine('bad', t('add.probeFailed', { msg: r.error }));
    return;
  }
  addState.probedName = r.info.fileName;
  if (!addState.nameEdited) addName.value = r.info.fileName;
  const size = r.info.size !== null ? formatSize(r.info.size, lang) : t('add.sizeUnknown');
  setProbeLine('ok', `${size}  |  ${r.info.resumable ? t('add.resumable') : t('add.notResumable')}`);
  refreshAddButtons();
}

function scheduleProbe(delay = 450): void {
  window.clearTimeout(addState.probeTimer);
  refreshAddButtons();
  addState.probeTimer = window.setTimeout(() => void runProbe(), delay);
}

async function openAdd(prefill?: AddPrefill): Promise<void> {
  if (addDlg.open) {
    if (prefill) pendingPrefills.push(prefill);
    return;
  }
  addState.dirOverride = null;
  addState.nameEdited = false;
  addState.probedName = '';
  addState.busy = false;
  addState.bridgeToken = prefill?.bridgeToken ?? null;
  let url = prefill?.url ?? '';
  if (!prefill) {
    const c = await api.readClipboardUrl();
    if (c.ok && c.url) url = c.url;
  }
  addState.prefillUrl = prefill ? url : null;
  addUrl.value = url;
  addName.value = prefill?.fileName ?? '';
  addState.nameEdited = !!prefill?.fileName;
  addConn.value = String(settings.defaultConnections);
  const src = $('addSource');
  const note =
    prefill && prefill.source !== 'drop'
      ? [prefill.source === 'clipboard' ? t('add.fromClipboard') : t('add.fromBrowser'), prefill.hasCookie ? t('add.cookieNote') : ''].filter(Boolean).join(' ')
      : '';
  src.hidden = note === '';
  src.textContent = note;
  setProbeLine('none');
  refreshAddButtons();
  addDlg.showModal();
  addUrl.focus();
  addUrl.select();
  if (url) scheduleProbe(0);
}

async function submitAdd(start: boolean): Promise<void> {
  const url = addUrl.value.trim();
  if (!isHttpUrl(url) || addState.busy) return;
  addState.busy = true;
  refreshAddButtons();
  const token = url === addState.prefillUrl ? addState.bridgeToken : null;
  const name = addName.value.trim();
  const r = await api.add({
    url, fileName: name || null, dir: addState.dirOverride, connections: Number(addConn.value) || settings.defaultConnections, start, bridgeToken: token,
  });
  addState.busy = false;
  if (!r.ok) {
    errorToast(r.error);
    refreshAddButtons();
    return;
  }
  closeAdd();
  toast('success', start ? t('toast.added') : t('toast.queued'));
}

function closeAdd(): void {
  window.clearTimeout(addState.probeTimer);
  addState.probeSeq++;
  if (addDlg.open) addDlg.close();
}

addDlg.addEventListener('close', () => {
  const next = pendingPrefills.shift();
  if (next) void openAdd(next);
});
addUrl.addEventListener('input', () => {
  addState.probedName = '';
  if (!addState.nameEdited) addName.value = '';
  scheduleProbe();
});
addUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void submitAdd(true);
  }
});
addName.addEventListener('input', () => {
  addState.nameEdited = addName.value.trim() !== '';
  refreshAddButtons();
});
addConn.addEventListener('input', refreshAddButtons);
$('addBrowse').addEventListener('click', async () => {
  const r = await api.pickFolder();
  if (r.ok && r.dir) {
    addState.dirOverride = r.dir;
    refreshAddButtons();
  }
});
$('addFolderReset').addEventListener('click', () => {
  addState.dirOverride = null;
  refreshAddButtons();
});
$('addCancel').addEventListener('click', closeAdd);
addStart.addEventListener('click', () => void submitAdd(true));
addQueue.addEventListener('click', () => void submitAdd(false));

// ----------------------------------------------------------- settings dialog

const setDlg = $<HTMLDialogElement>('settingsDialog');

function fillSettings(): void {
  $<HTMLInputElement>('setFolder').value = settings.defaultDir;
  $<HTMLInputElement>('setSubfolders').checked = settings.categorySubfolders;
  $<HTMLInputElement>('setMax').value = String(settings.maxConcurrent);
  $<HTMLInputElement>('setConn').value = String(settings.defaultConnections);
  $<HTMLInputElement>('setLimit').value = String(settings.speedLimitKiBps);
  $<HTMLSelectElement>('setTheme').value = settings.theme;
  $<HTMLSelectElement>('setLang').value = settings.language;
  $<HTMLInputElement>('setTray').checked = settings.closeToTray;
  $<HTMLInputElement>('setNotify').checked = settings.notifyOnComplete;
  $<HTMLInputElement>('setStartup').checked = settings.startWithWindows;
  $<HTMLInputElement>('setClip').checked = settings.clipboardWatch;
  $<HTMLInputElement>('setAuto').checked = settings.browserAutoStart;
}

function openSettings(): void {
  fillSettings();
  if (!setDlg.open) setDlg.showModal();
}

async function applySetting(patch: Partial<Settings>): Promise<void> {
  const r = await api.setSettings(patch);
  if (!r.ok) {
    toast('error', t('toast.settingsRejected', { msg: r.error }));
    fillSettings();
  }
}

function bindCheck(id: string, key: keyof Settings): void {
  $<HTMLInputElement>(id).addEventListener('change', (e) => void applySetting({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>));
}
function bindNumber(id: string, key: keyof Settings, min: number, max: number): void {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const v = Math.max(min, Math.min(max, Math.round(Number(input.value))));
    if (!Number.isFinite(v)) return fillSettings();
    input.value = String(v);
    void applySetting({ [key]: v } as Partial<Settings>);
  });
}
bindCheck('setSubfolders', 'categorySubfolders');
bindCheck('setTray', 'closeToTray');
bindCheck('setNotify', 'notifyOnComplete');
bindCheck('setStartup', 'startWithWindows');
bindCheck('setClip', 'clipboardWatch');
bindCheck('setAuto', 'browserAutoStart');
bindNumber('setMax', 'maxConcurrent', 1, 10);
bindNumber('setConn', 'defaultConnections', 1, 16);
bindNumber('setLimit', 'speedLimitKiBps', 0, 10_000_000);
$('setTheme').addEventListener('change', (e) => void applySetting({ theme: (e.target as HTMLSelectElement).value as Settings['theme'] }));
$('setLang').addEventListener('change', (e) => void applySetting({ language: (e.target as HTMLSelectElement).value as Settings['language'] }));
$('setBrowse').addEventListener('click', async () => {
  const r = await api.pickFolder();
  if (r.ok && r.dir) await applySetting({ defaultDir: r.dir });
});
$('settingsClose').addEventListener('click', () => setDlg.close());

// -------------------------------------------------------- keyboard and drops

function typingTarget(e: Event): boolean {
  const el = e.target as HTMLElement;
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
}
function anyDialogOpen(): boolean {
  return addDlg.open || setDlg.open || $<HTMLDialogElement>('confirmDialog').open;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
  if (anyDialogOpen() || typingTarget(e)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    setSelection(visibleOrder);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    void openAdd();
  } else if (e.key === 'Delete' && selected.size > 0) {
    e.preventDefault();
    void doDelete(e.shiftKey);
  } else if (e.key === 'Enter' && selected.size === 1) {
    const it = selectedItems()[0];
    if (it.status === 'done') void doOpen(it.id);
    else toggleDetail(true);
  }
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;
  const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).map((s) => s.trim()).find((s) => isHttpUrl(s));
  if (text) void openAdd({ url: text, fileName: null, bridgeToken: null, hasCookie: false, source: 'drop' });
});

// ------------------------------------------------------------- state wiring

function applyBatch(b: ItemsBatch): void {
  for (const it of b.upserts) items.set(it.id, it);
  for (const id of b.removed) items.delete(id);
  if (watchedId && b.removed.includes(watchedId)) {
    watchedId = null;
  }
  const one = selected.size === 1 ? items.get([...selected][0]) : undefined;
  if (one && detail.visible) detail.setItem(one);
  queueRender();
}

function applySettings(s: Settings, first = false): void {
  const langChanged = s.language !== lang;
  settings = s;
  lang = s.language;
  if (langChanged || first) {
    applyI18n();
    relabelSidebar();
    detail.relabel();
    for (const r of rows.values()) r.cache = {};
  }
  if (!setDlg.open) fillSettings();
  else $<HTMLInputElement>('setFolder').value = s.defaultDir;
  refreshAddButtons();
  queueRender();
}

async function init(): Promise<void> {
  const st = await api.getState();
  version = st.version;
  settings = st.settings;
  lang = settings.language;
  detail = new DetailPanel({ t, lang: () => lang, statusLabel });
  $('emptyIcon').replaceChildren(icon('download', 48));
  buildSidebar();
  applySettings(settings, true);
  for (const it of st.items) items.set(it.id, it);
  renderList();

  api.onItems(applyBatch);
  api.onSettings((s) => applySettings(s));
  api.onDetail((d) => detail.setDetail(d));
  api.onShowAdd((p) => void openAdd(p));
  api.onToast((m: ToastMessage) => toast(m.kind, m.key ? t(m.key as StringKey, { msg: m.text }) : m.text));
  await api.ready();
  document.body.dataset.ready = '1';
}

void init();
