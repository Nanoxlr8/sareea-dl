import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBuffer, rmDir, sha256, startServer, tmpDir } from './helpers.ts';
import type { TestServer } from './helpers.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

function runCli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('cli', () => {
  const servers: TestServer[] = [];
  const dirs: string[] = [];
  after(async () => {
    for (const s of servers) await s.close();
    for (const d of dirs) rmDir(d);
  });

  it('downloads a file and prints the saved path and hash', async () => {
    const data = makeBuffer(2 * 1024 * 1024, 21);
    const server = await startServer({ buffer: data });
    servers.push(server);
    const dir = tmpDir();
    dirs.push(dir);
    const r = await runCli([`${server.url}/cli.bin`, '-o', dir, '-c', '4', '--limit', '8M']);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /Saved: /);
    assert.ok(r.out.includes(sha256(data)));
    assert.equal(sha256(fs.readFileSync(path.join(dir, 'cli.bin'))), sha256(data));
  });

  it('exits with usage errors for bad arguments', async () => {
    assert.equal((await runCli([])).code, 2);
    assert.equal((await runCli(['ftp://example.com/x'])).code, 2);
    assert.equal((await runCli(['http://127.0.0.1:1/x', '-c', '99'])).code, 2);
    assert.equal((await runCli(['http://127.0.0.1:1/x', '--limit', 'fast'])).code, 2);
  });
});
