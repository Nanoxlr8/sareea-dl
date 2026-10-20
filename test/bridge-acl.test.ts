/**
 * How the pipe-ACL clean-up calls PowerShell: absolute path under %SystemRoot%\System32, fixed arguments,
 * and a pipe name that only ever travels as an environment value, whatever the Windows user name looks like.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BridgeServer, buildPipeAclCommand, pipeNameFor, restrictPipeToCurrentUser, TIGHTEN_SCRIPT } from '../src/main/bridge.ts';
import { Logger } from '../src/main/logger.ts';
import { rmDir, tmpDir } from './helpers.ts';

const dir = tmpDir('sareea-acl-');
after(() => rmDir(dir));

const PREFIX = /^\\\\\.\\pipe\\/;
const SYSTEM32_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const FIXED_ARGS = ['-NoProfile', '-NonInteractive', '-Command', TIGHTEN_SCRIPT];
const HOSTILE_USERS = [
  "a';calc;'",
  'a"; Start-Process calc; "',
  '$(calc)',
  '`calc`',
  'x & calc',
  'x | calc',
  '..\\..\\evil',
  "a' -ErrorAction Stop; calc #",
  '%SystemRoot%',
  'a\r\nb',
  'a\u0000b',
  'Ümit',
  '',
  'x'.repeat(500),
];

describe('pipe ACL command (how PowerShell is called)', () => {
  it('uses the absolute System32 powershell.exe, fixed arguments, and the pipe name only as an environment value', () => {
    for (const user of HOSTILE_USERS) {
      const pipe = pipeNameFor(user);
      const cmd = buildPipeAclCommand(pipe, { SystemRoot: 'C:\\Windows', Path: 'C:\\evil' });
      assert.equal(cmd.file, SYSTEM32_PS, JSON.stringify(user));
      assert.deepEqual(cmd.args, FIXED_ARGS, JSON.stringify(user));
      const name = pipe.replace(PREFIX, '');
      assert.equal(cmd.env.SAREEA_PIPE_NAME, name);
      assert.match(name, /^sareea-dl-[A-Za-z0-9._-]{1,64}$/);
      // nothing derived from the user name is anywhere in the command line
      for (const a of [cmd.file, ...cmd.args]) assert.ok(!a.includes(name) && !/calc|evil/i.test(a), `${JSON.stringify(user)} leaked into: ${a}`);
    }
  });

  it("the classic injection name a';calc;' becomes a plain, harmless pipe name", () => {
    assert.equal(pipeNameFor("a';calc;'"), '\\\\.\\pipe\\sareea-dl-a__calc__');
    const cmd = buildPipeAclCommand(pipeNameFor("a';calc;'"), { SystemRoot: 'C:\\Windows' });
    assert.equal(cmd.env.SAREEA_PIPE_NAME, 'sareea-dl-a__calc__');
    assert.deepEqual(cmd.args, FIXED_ARGS);
    assert.ok(!TIGHTEN_SCRIPT.includes('calc'));
  });

  it('the script is fixed text that reads the pipe name from the environment, not from its own text', () => {
    assert.ok(TIGHTEN_SCRIPT.includes('$env:SAREEA_PIPE_NAME'));
    assert.ok(!/sareea-dl-/.test(TIGHTEN_SCRIPT));
    assert.ok(!/Invoke-Expression|iex |Start-Process|DownloadString/i.test(TIGHTEN_SCRIPT));
  });

  it('refuses a pipe name that pipeNameFor could not have made, without building any command', () => {
    const bad = [
      "\\\\.\\pipe\\a';calc;'",
      '\\\\.\\pipe\\a b',
      '\\\\.\\pipe\\',
      'sareea-dl-x',
      '\\\\.\\pipe\\x\\..\\y',
      '\\\\.\\pipe\\x$(calc)',
      '\\\\.\\pipe\\x\ny',
      '\\\\server\\pipe\\x',
      "a';calc;'",
    ];
    for (const b of bad) assert.throws(() => buildPipeAclCommand(b, { SystemRoot: 'C:\\Windows' }), /unsafe name/, JSON.stringify(b));
  });

  it('takes %SystemRoot% only when it is a plain absolute local path, otherwise C:\\Windows', () => {
    const ok = buildPipeAclCommand(pipeNameFor('u'), { SystemRoot: 'D:\\WINNT' });
    assert.equal(ok.file, 'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    for (const root of ['', undefined, 'Windows', '\\\\evil\\share', 'C:\\Windows"; calc; "', 'C:\\..\\evil', 'C:\\a;b', '.\\x', 'C:\\Win\ndows']) {
      const cmd = buildPipeAclCommand(pipeNameFor('u'), { SystemRoot: root });
      assert.equal(cmd.file, SYSTEM32_PS, JSON.stringify(root));
    }
  });

  it('restrictPipeToCurrentUser says no for an unsafe pipe name and starts nothing', async () => {
    assert.equal(await restrictPipeToCurrentUser("\\\\.\\pipe\\a';calc;'"), false);
  });

  it('really tightens a pipe that belongs to a hostile user name (the sanitised name works end to end)', { skip: process.platform !== 'win32' }, async () => {
    const hostile = pipeNameFor("a';calc;'", `-test-${process.pid}-${Date.now()}`);
    const s = new BridgeServer({ pipe: hostile, log: new Logger(path.join(dir, 'logs'), false), onAdd: async () => ({ ok: true }) });
    assert.equal(await s.start(), true);
    assert.equal(await s.aclReady, true);
    await s.stop();
  });
});
