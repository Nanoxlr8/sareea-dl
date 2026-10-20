/** Category mapping by file extension. Pure: no Electron, no Node-only APIs. */

export type Category = 'compressed' | 'documents' | 'music' | 'programs' | 'video' | 'other';
/** What the sidebar can filter on. */
export type CategoryFilter = 'all' | Exclude<Category, 'other'> | 'unfinished' | 'finished';

const EXTENSIONS: Record<Exclude<Category, 'other'>, string[]> = {
  compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'lz', 'z'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'epub', 'md', 'djvu', 'xps'],
  music: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'opus', 'aiff', 'mid', 'midi'],
  programs: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'dmg', 'pkg', 'iso', 'img', 'apk', 'deb', 'rpm', 'bat', 'cmd', 'jar', 'appimage'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp', 'ogv', 'vob'],
};

const BY_EXT = new Map<string, Exclude<Category, 'other'>>();
for (const [cat, list] of Object.entries(EXTENSIONS)) {
  for (const ext of list) BY_EXT.set(ext, cat as Exclude<Category, 'other'>);
}

/** Extensions that run code or install software when opened. "Open" asks first for these. */
const RISKY = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'hta', 'lnk', 'reg', 'jar', 'dll', 'cpl', 'msc', 'msp', 'application', 'gadget', 'docm', 'xlsm', 'pptm', 'iso', 'img', 'apk',
]);

export const CATEGORY_ORDER: Exclude<Category, 'other'>[] = ['compressed', 'documents', 'music', 'programs', 'video'];

/** Lower-case extension without the dot, or '' if there is none ("a.tar.gz" gives "gz"; ".bashrc" gives ""). */
export function extensionOf(fileName: string): string {
  const base = fileName.replace(/^.*[\/]/, '');
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

export function categoryOf(fileName: string | null | undefined): Category {
  if (!fileName) return 'other';
  return BY_EXT.get(extensionOf(fileName)) ?? 'other';
}

/** Folder name used when "per-category subfolders" is on. Not translated: it is a path on disk. */
export function subfolderFor(category: Category): string {
  switch (category) {
    case 'compressed':
      return 'Compressed';
    case 'documents':
      return 'Documents';
    case 'music':
      return 'Music';
    case 'programs':
      return 'Programs';
    case 'video':
      return 'Video';
    default:
      return 'General';
  }
}

export function isDownloadableExtension(ext: string): boolean {
  return BY_EXT.has(ext.toLowerCase());
}

export function isRiskyFile(fileName: string): boolean {
  return RISKY.has(extensionOf(fileName));
}

/** Does an item with this name and status appear under the given sidebar filter? */
export function matchesFilter(filter: CategoryFilter, fileName: string | null, status: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'finished':
      return status === 'done';
    case 'unfinished':
      return status !== 'done';
    default:
      return categoryOf(fileName) === filter;
  }
}

/** True if text is one http(s) URL (nothing else) whose path ends in a known downloadable extension. */
export function looksLikeDownloadLink(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 8192 || /\s/.test(t)) return false;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  let name = u.pathname;
  try {
    name = decodeURIComponent(u.pathname);
  } catch {
    /* keep the raw path */
  }
  return isDownloadableExtension(extensionOf(name));
}
