/**
 * Pure segment arithmetic for multi-connection downloads.
 * A segment covers bytes start..end (inclusive); `pos` is the next byte not yet
 * claimed, so a segment is finished when pos > end and has end - pos + 1 bytes left.
 */
export interface Segment {
  start: number;
  end: number;
  pos: number;
}

export const KiB = 1024;
export const MiB = 1024 * 1024;

export function remaining(s: Segment): number {
  return Math.max(0, s.end - s.pos + 1);
}

export function isComplete(s: Segment): boolean {
  return s.pos > s.end;
}

/** Bytes already done across all segments. */
export function downloadedBytes(segments: Segment[]): number {
  let total = 0;
  for (const s of segments) total += Math.max(0, Math.min(s.pos, s.end + 1) - s.start);
  return total;
}

/**
 * Split `size` bytes into at most `n` contiguous segments of near-equal size
 * (none smaller than minSegmentSize unless the whole file is smaller).
 */
export function splitInitial(size: number, n: number, minSegmentSize = 256 * KiB): Segment[] {
  if (!Number.isInteger(size) || size < 0) throw new RangeError('size must be a non-negative integer');
  if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  if (size === 0) return [];
  const count = Math.max(1, Math.min(n, Math.floor(size / Math.max(1, minSegmentSize))));
  const base = Math.floor(size / count);
  const extra = size % count;
  const out: Segment[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const len = base + (i < extra ? 1 : 0);
    out.push({ start, end: start + len - 1, pos: start });
    start += len;
  }
  return out;
}

/**
 * IDM-style dynamic segmentation. Finds the segment with the most bytes left; if
 * more than `minSplit` remain, the victim keeps the first half of what is left
 * and a new segment takes the rest. The new segment is inserted after the victim
 * (list stays sorted by start) and returned. Returns null if nothing is worth splitting.
 * Mutates the victim's `end` and the array.
 */
export function stealWork(segments: Segment[], minSplit = MiB): Segment | null {
  let bestIdx = -1;
  let bestRem = 0;
  for (let i = 0; i < segments.length; i++) {
    const r = remaining(segments[i]);
    if (r > bestRem) {
      bestRem = r;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestRem <= minSplit) return null;
  const victim = segments[bestIdx];
  const mid = victim.pos + Math.ceil(bestRem / 2);
  const thief: Segment = { start: mid, end: victim.end, pos: mid };
  victim.end = mid - 1;
  segments.splice(bestIdx + 1, 0, thief);
  return thief;
}

/** True if segments are sorted, contiguous, non-overlapping, cover 0..size-1 and have sane pos values. */
export function validateSegments(segments: unknown, size: number): segments is Segment[] {
  if (!Array.isArray(segments)) return false;
  if (size === 0) return segments.length === 0;
  let expected = 0;
  for (const s of segments) {
    if (!s || !Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end) || !Number.isSafeInteger(s.pos)) return false;
    if (s.start !== expected || s.end < s.start) return false;
    if (s.pos < s.start || s.pos > s.end + 1) return false;
    expected = s.end + 1;
  }
  return expected === size;
}
