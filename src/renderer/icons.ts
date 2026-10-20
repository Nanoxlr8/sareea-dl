/** Small stroke icons (24x24). Built with createElementNS, never from strings of markup. */

function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

const PATHS: Record<string, string[]> = {
  add: ['M12 5v14M5 12h14'],
  play: ['M8 5l11 7-11 7z'],
  pause: ['M8 5v14M16 5v14'],
  trash: ['M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'],
  trashx: ['M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3M10 11l4 5M14 11l-4 5'],
  queueStart: ['M4 6h10M4 12h6M4 18h6M15 10l6 3.5-6 3.5z'],
  queueStop: ['M4 6h10M4 12h6M4 18h6M15 11h6v6h-6z'],
  sliders: ['M4 7h8M18 7h2M4 17h2M12 17h8', circle(15, 7, 3), circle(9, 17, 3)],
  panel: ['M4 5h16v14H4zM4 13h16'],
  close: ['M6 6l12 12M18 6L6 18'],
  all: ['M4 6h16M4 12h16M4 18h16'],
  compressed: ['M4 5h16v4H4zM5 9v10h14V9M10 13h4'],
  documents: ['M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6'],
  music: ['M9 18V6l10-2v12', circle(6, 18, 3), circle(16, 16, 3)],
  programs: ['M4 5h16v14H4zM4 9h16M7 7h.01M10 7h.01'],
  video: ['M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4'],
  other: ['M7 3h7l5 5v13H7zM14 3v5h5'],
  unfinished: [circle(12, 12, 9), 'M12 7v5l3 2'],
  finished: [circle(12, 12, 9), 'M8 12l3 3 5-6'],
  folder: ['M3 6h6l2 2h10v11H3z'],
  copy: ['M9 9h11v11H9zM5 15V4h11'],
  redo: ['M20 12a8 8 0 1 0-2.4 5.7M20 5v7h-7'],
  open: ['M14 4h6v6M20 4l-9 9M18 14v6H4V6h6'],
  warn: ['M12 4l9 16H3zM12 10v4M12 17h.01'],
  check: ['M5 12l5 5 9-10'],
  download: ['M12 4v11M7 11l5 5 5-5M5 20h14'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of PATHS[name] ?? PATHS.other) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
