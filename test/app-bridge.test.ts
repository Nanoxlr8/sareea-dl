import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { BridgeServer, pipeNameFor } from '../src/main/bridge.ts';
import { Logger } from '../src/main/logger.ts';
import { rmDir, tmpDir } from './helpers.ts';
import type { BridgeRequest } from '../src/app/protocol.ts';

const dir = tmpDir('sareea-bridge-');
const pipe = pipeNameFor('tester', `-test-${process.pid}-${Date.now()}`);
const added: Extract<BridgeRequest, { type: 'add' }>[] = [];
let server: BridgeServer;

function exchange(payload: string, replies: number, closeAfter = false): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    sock.setEncoding('utf8');
    let buf = '';
    const out: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout, got ' + JSON.stringify(out)));
    }, 5000);
    const finish = () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(out);
    };
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (out.length >= replies && !closeAfter) return finish();
      }
    });
    sock.on('close', finish);
    sock.on('error', reject);
  });
}

before(async () => {
  server = new BridgeServer({
    pipe,
    log: new Logger(path.join(dir, 'logs'), false),
    onAdd: async (r) => {
      added.push(r);
      return r.url.includes('reject') ? { ok: false, error: 'declined' } : { ok: true };
    },
  });
  assert.equal(await server.start(), true);
});
after(async () => {
  await server.stop();
  rmDir(dir);
});

describe('pipe name', () => {
  it('carries the user name and a safe character set', () => {
    assert.equal(pipeNameFor('alice'), '\\\\.\\pipe\\sareea-dl-alice');
    assert.equal(pipeNameFor('A B\\C/..'), '\\\\.\\pipe\\sareea-dl-A_B_C_..');
    assert.ok(pipeNameFor().startsWith('\\\\.\\pipe\\sareea-dl-'));
    assert.ok(pipeNameFor().includes(os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_')));
  });
});

describe('BridgeServer over a real named pipe', { skip: process.platform !== 'win32' }, () => {
  it('answers ping', async () => {
    const [r] = await exchange('{"v":1,"id":"p1","type":"ping"}\n', 1);
    assert.deepEqual(r, { v: 1, id: 'p1', ok: true });
  });

  it('answers several requests on one connection, in order', async () => {
    const r = await exchange('{"v":1,"id":1,"type":"ping"}\n{"v":1,"id":2,"type":"ping"}\n{"v":1,"id":3,"type":"ping"}\n', 3);
    assert.deepEqual(r.map((x) => x.id), [1, 2, 3]);
  });

  it('passes a valid add to the app and relays its answer', async () => {
    added.length = 0;
    const [ok, no] = await exchange(
      '{"v":1,"id":"a","type":"add","url":"https://example.com/x.zip","fileName":"x.zip","headers":{"cookie":"k=v"}}\n{"v":1,"id":"b","type":"add","url":"https://example.com/reject.zip"}\n',
      2,
    );
    assert.deepEqual(ok, { v: 1, id: 'a', ok: true });
    assert.deepEqual(no, { v: 1, id: 'b', ok: false, error: 'declined' });
    assert.equal(added.length, 2);
    assert.equal(added[0].cookie, 'k=v');
    assert.equal(added[0].fileName, 'x.zip');
  });

  it('rejects invalid requests without calling the app', async () => {
    added.length = 0;
    const r = await exchange(
      ['{"v":1,"id":"1","type":"add","url":"ftp://x.com/a"}', '{"v":1,"id":"2","type":"add","url":"file:///C:/a.exe"}', 'garbage', '{"v":9,"id":"4","type":"ping"}', '{"v":1,"id":"5","type":"shell","cmd":"calc"}'].join('\n') + '\n',
      5,
    );
    assert.equal(r.length, 5);
    assert.ok(r.every((x) => x.ok === false && typeof x.error === 'string'));
    assert.equal(r[0].id, '1');
    assert.equal(r[2].id, null);
    assert.equal(added.length, 0);
  });

  it('closes a connection that sends an over-long line', async () => {
    const r = await exchange('y'.repeat(70 * 1024) + '\n', 1, true);
    assert.equal(r[0]?.ok, false);
    assert.equal(r[0]?.error, 'line too long');
  });

  it('closes a connection that never sends a newline, without waiting', async () => {
    const r = await exchange('z'.repeat(200 * 1024), 1, true);
    assert.equal(r[0]?.error, 'line too long');
  });

  it('limits the requests on one connection', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `{"v":1,"id":${i},"type":"ping"}`).join('\n') + '\n';
    const r = await exchange(lines, 1000, true);
    assert.ok(r.length <= 52);
    assert.equal(r.at(-1)?.error, 'too many requests on one connection');
  });

  it('keeps only the current user, Administrators and SYSTEM in the pipe ACL (no Everyone, no Anonymous)', async () => {
    assert.equal(await server.aclReady, true);
    const script = [
      "$r = [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions'",
      "$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:PIPE_NAME, $r, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification, [System.IO.HandleInheritability]::None)",
      '$c.Connect(5000)',
      '$sec = $c.GetAccessControl()',
      '$sec.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }',
      '$c.Dispose()',
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PIPE_NAME: pipe.replace(/^\\\\\.\\pipe\\/, '') },
      encoding: 'utf8',
      windowsHide: true,
    });
    const sids = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    assert.ok(sids.length >= 2, 'rules were read: ' + sids.join(','));
    assert.ok(!sids.includes('S-1-1-0'), 'Everyone removed');
    assert.ok(!sids.includes('S-1-5-7'), 'Anonymous removed');
    assert.ok(sids.includes('S-1-5-18'), 'SYSTEM kept');
    assert.ok(sids.includes('S-1-5-32-544'), 'Administrators kept');
    // and the owner can still use the pipe afterwards
    const [pong] = await exchange('{"v":1,"id":"after","type":"ping"}\n', 1);
    assert.deepEqual(pong, { v: 1, id: 'after', ok: true });
  });

  it('refuses a second server on the same pipe name (squatting or double start)', async () => {
    const second = new BridgeServer({ pipe, log: new Logger(path.join(dir, 'logs2'), false), onAdd: async () => ({ ok: true }), restrictAcl: false });
    assert.equal(await second.start(), false);
  });
});
