import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadedBytes, isComplete, MiB, remaining, splitInitial, stealWork, validateSegments } from '../src/segments.ts';
import type { Segment } from '../src/segments.ts';

/** Every byte 0..size-1 is covered exactly once by the (already sorted) segments. */
function assertExactCover(segments: Segment[], size: number): void {
  let next = 0;
  for (const s of segments) {
    assert.equal(s.start, next, `gap or overlap before segment starting at ${s.start}`);
    assert.ok(s.end >= s.start, 'segment is not empty');
    next = s.end + 1;
  }
  assert.equal(next, size);
}

/** Small deterministic PRNG so the "random" tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('splitInitial', () => {
  it('splits evenly and covers everything', () => {
    const segs = splitInitial(8 * MiB, 8);
    assert.equal(segs.length, 8);
    assert.ok(segs.every((s) => s.end - s.start + 1 === MiB));
    assert.ok(segs.every((s) => s.pos === s.start));
    assertExactCover(segs, 8 * MiB);
  });

  it('spreads the remainder over the first segments', () => {
    const segs = splitInitial(1000003, 4, 1);
    assertExactCover(segs, 1000003);
    const sizes = segs.map((s) => s.end - s.start + 1);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  });

  it('uses fewer segments for small files (minSegmentSize)', () => {
    assert.equal(splitInitial(100, 8).length, 1);
    assert.equal(splitInitial(1 * MiB, 8).length, 4);
    assert.equal(splitInitial(1 * MiB, 2).length, 2);
  });

  it('handles size 0 and 1', () => {
    assert.deepEqual(splitInitial(0, 8), []);
    assert.deepEqual(splitInitial(1, 8), [{ start: 0, end: 0, pos: 0 }]);
  });

  it('rejects nonsense', () => {
    assert.throws(() => splitInitial(-1, 4), RangeError);
    assert.throws(() => splitInitial(10, 0), RangeError);
    assert.throws(() => splitInitial(1.5, 2), RangeError);
  });

  it('covers every size/count combination exactly', () => {
    const r = rng(42);
    for (let i = 0; i < 500; i++) {
      const size = 1 + Math.floor(r() * 50 * MiB);
      const n = 1 + Math.floor(r() * 32);
      assertExactCover(splitInitial(size, n), size);
    }
  });
});

describe('stealWork', () => {
  it('splits the largest remaining segment in half', () => {
    const segs: Segment[] = [
      { start: 0, end: 3 * MiB - 1, pos: 3 * MiB }, // done
      { start: 3 * MiB, end: 5 * MiB - 1, pos: 3 * MiB }, // 2 MiB left
      { start: 5 * MiB, end: 10 * MiB - 1, pos: 6 * MiB }, // 4 MiB left  <- victim
    ];
    const thief = stealWork(segs);
    assert.ok(thief);
    assert.equal(segs.length, 4);
    assert.equal(segs[2].end - segs[2].pos + 1, 2 * MiB, 'victim keeps half of what was left');
    assert.deepEqual(thief, { start: 8 * MiB, end: 10 * MiB - 1, pos: 8 * MiB });
    assert.equal(segs[3], thief, 'thief is inserted right after the victim');
    assertExactCover(segs, 10 * MiB);
  });

  it('does not touch bytes already downloaded', () => {
    const segs: Segment[] = [{ start: 0, end: 9 * MiB - 1, pos: 5 * MiB }];
    const before = downloadedBytes(segs);
    const thief = stealWork(segs);
    assert.ok(thief);
    assert.equal(downloadedBytes(segs), before);
    assert.ok(thief.start >= 5 * MiB, 'stolen range lies in the part nobody fetched yet');
    assert.ok(segs[0].end >= segs[0].pos, 'victim still has work');
  });

  it('refuses when 1 MiB or less remains', () => {
    const segs: Segment[] = [{ start: 0, end: MiB - 1, pos: 0 }];
    assert.equal(stealWork(segs), null);
    assert.deepEqual(segs, [{ start: 0, end: MiB - 1, pos: 0 }], 'nothing changed');
    const barely: Segment[] = [{ start: 0, end: MiB, pos: 0 }]; // 1 MiB + 1 byte
    assert.ok(stealWork(barely));
    assertExactCover(barely, MiB + 1);
  });

  it('refuses with no segments or only finished ones', () => {
    assert.equal(stealWork([]), null);
    assert.equal(stealWork([{ start: 0, end: 9 * MiB, pos: 9 * MiB + 1 }]), null);
  });

  it('honours a custom threshold', () => {
    const segs: Segment[] = [{ start: 0, end: 99, pos: 0 }];
    assert.equal(stealWork(segs, 100), null);
    assert.ok(stealWork(segs, 10));
    assertExactCover(segs, 100);
  });

  it('keeps picking the largest remainder', () => {
    const segs: Segment[] = [
      { start: 0, end: 3 * MiB - 1, pos: 0 },
      { start: 3 * MiB, end: 9 * MiB - 1, pos: 3 * MiB },
    ];
    const first = stealWork(segs);
    assert.equal(first?.start, 6 * MiB, 'split the 6 MiB segment, not the 3 MiB one');
  });

  it('never overlaps and always covers, under random progress and stealing', () => {
    const r = rng(2024);
    for (let round = 0; round < 200; round++) {
      const size = 1 + Math.floor(r() * 200 * MiB);
      const segs = splitInitial(size, 1 + Math.floor(r() * 16));
      for (let step = 0; step < 100; step++) {
        // some worker makes progress on a random segment
        const s = segs[Math.floor(r() * segs.length)];
        s.pos = Math.min(s.end + 1, s.pos + Math.floor(r() * 4 * MiB));
        // another one runs dry and steals
        if (r() < 0.5) stealWork(segs, MiB);
        assertExactCover(segs, size);
        assert.ok(validateSegments(segs, size));
        for (const x of segs) assert.ok(x.pos >= x.start && x.pos <= x.end + 1);
      }
    }
  });

  it('downloads every byte exactly once when workers drain and steal until nothing is left', () => {
    const size = 37 * MiB + 12345;
    const segs = splitInitial(size, 4);
    const fetched = new Uint8Array(Math.ceil(size / 1024)); // one counter per KiB block is enough to spot overlap
    const r = rng(7);
    // Simulated workers: each loop iteration one worker advances its segment by a chunk;
    // a worker with no segment steals.
    const owner = new Map<Segment, number>();
    const workers = 6;
    const held: Array<Segment | null> = new Array(workers).fill(null);
    for (let i = 0; i < 4; i++) {
      held[i] = segs[i];
      owner.set(segs[i], i);
    }
    let guard = 0;
    while (segs.some((s) => remaining(s) > 0) && guard++ < 1e6) {
      const w = Math.floor(r() * workers);
      let seg = held[w];
      if (!seg || isComplete(seg)) {
        seg = segs.find((s) => remaining(s) > 0 && !held.includes(s)) ?? stealWork(segs, MiB);
        held[w] = seg;
        if (!seg) continue;
      }
      const room = remaining(seg);
      const n = Math.min(room, 1 + Math.floor(r() * 512 * 1024));
      for (let b = seg.pos; b < seg.pos + n; b++) fetched[Math.floor(b / 1024)]++;
      seg.pos += n;
    }
    assert.ok(guard < 1e6, 'simulation finished');
    assertExactCover(segs, size);
    // KiB blocks at segment borders can legitimately be touched by two segments, so compare byte totals instead
    assert.equal(downloadedBytes(segs), size);
  });
});

describe('validateSegments', () => {
  it('accepts a good list', () => {
    assert.ok(validateSegments(splitInitial(10 * MiB, 4), 10 * MiB));
    assert.ok(validateSegments([], 0));
  });
  it('rejects gaps, overlaps, wrong totals and bad pos', () => {
    assert.ok(!validateSegments([{ start: 0, end: 9, pos: 0 }, { start: 11, end: 19, pos: 11 }], 20), 'gap');
    assert.ok(!validateSegments([{ start: 0, end: 10, pos: 0 }, { start: 10, end: 19, pos: 10 }], 20), 'overlap');
    assert.ok(!validateSegments([{ start: 0, end: 9, pos: 0 }], 20), 'short');
    assert.ok(!validateSegments([{ start: 0, end: 9, pos: 11 }], 10), 'pos past end+1');
    assert.ok(!validateSegments([{ start: 0, end: 9, pos: -1 }], 10), 'pos before start');
    assert.ok(!validateSegments('nope', 10));
    assert.ok(!validateSegments([{ start: 0, end: 'x', pos: 0 }], 10));
  });
});

describe('downloadedBytes', () => {
  it('sums progress and ignores overshoot', () => {
    assert.equal(downloadedBytes([{ start: 0, end: 99, pos: 40 }, { start: 100, end: 199, pos: 200 }]), 40 + 100);
    assert.equal(downloadedBytes([]), 0);
  });
});
