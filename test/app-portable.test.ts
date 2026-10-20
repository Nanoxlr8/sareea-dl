import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveUserDataDir } from '../src/app/portable.ts';

const exeDir = path.join('X:', 'apps', 'sareea');
const appDataDir = path.join('X:', 'roaming');

test('no portable.txt: userData stays in appData', () => {
  assert.equal(resolveUserDataDir({ exeDir, appDataDir, fileExists: () => false }), path.join(appDataDir, 'Sareea DL'));
});

test('portable.txt beside the exe: userData is the data folder beside the exe', () => {
  const seen: string[] = [];
  const r = resolveUserDataDir({ exeDir, appDataDir, fileExists: (p) => (seen.push(p), true) });
  assert.equal(r, path.join(exeDir, 'data'));
  assert.deepEqual(seen, [path.join(exeDir, 'portable.txt')]);
});
