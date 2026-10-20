/**
 * Local bridge server: a Windows named pipe, newline-delimited JSON, one reply per request.
 * Node creates the pipe with Windows' default security descriptor, which also grants read access to
 * "Everyone" and "Anonymous". Right after listening we remove those two entries (see
 * restrictPipeToCurrentUser), leaving only the signed-in user, Administrators and SYSTEM. Even before
 * that, other users could never write to the pipe, so they could not send us anything. The pipe name
 * carries the user name so two users on one PC (fast user switching) never collide.
 * Protocol and limits: docs/protocol.md and src/app/protocol.ts.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { formatReply, LineSplitter, parseBridgeLine } from '../app/protocol.ts';
import type { BridgeRequest } from '../app/protocol.ts';
import type { Result } from '../app/api.ts';
import type { Logger } from './logger.ts';

export function pipeNameFor(username: string = os.userInfo().username, suffix = ''): string {
  const safe = username.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'user';
  return `\\\\.\\pipe\\sareea-dl-${safe}${suffix}`;
}

// Fixed script, no user data in it: the pipe name travels in an environment variable, never in the command text.
export const TIGHTEN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rights = [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions, ChangePermissions'",
  "$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:SAREEA_PIPE_NAME, $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification, [System.IO.HandleInheritability]::None)",
  '$c.Connect(5000)',
  '$sec = $c.GetAccessControl()',
  "foreach ($sid in @('S-1-1-0', 'S-1-5-7')) { $sec.PurgeAccessRules((New-Object System.Security.Principal.SecurityIdentifier($sid))) }",
  '$c.SetAccessControl($sec)',
  '$c.Dispose()',
].join('; ');

/** Name of the environment variable that carries the pipe name to the script. */
export const PIPE_NAME_ENV = 'SAREEA_PIPE_NAME';

/** The pipe name as PowerShell receives it: letters, digits, dot, underscore and hyphen only (what pipeNameFor makes). */
const SAFE_PIPE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const PIPE_PREFIX = /^\\\\\.\\pipe\\/;
/** %SystemRoot% is used only if it is an absolute local path without shell-special characters. */
const SAFE_SYSTEM_ROOT = /^[A-Za-z]:\\[A-Za-z0-9 ._()\\-]*$/;

export interface PipeAclCommand {
  /** Absolute path of powershell.exe under %SystemRoot%\System32 (never found through PATH). */
  file: string;
  /** Constant: the same for every user name and pipe name. */
  args: string[];
  /** The caller's environment plus the pipe name. */
  env: NodeJS.ProcessEnv;
}

/**
 * Builds the PowerShell call that removes Everyone and Anonymous from the pipe's ACL. Nothing derived from the
 * user name is ever put into the command line or the script: the arguments are constant and the pipe name
 * (already sanitised by pipeNameFor, and checked again here) goes through an environment variable that the
 * fixed script reads as data. Throws for anything that is not a \\.\pipe\ name made of safe characters only.
 */
export function buildPipeAclCommand(pipe: string, env: NodeJS.ProcessEnv = process.env): PipeAclCommand {
  const name = pipe.replace(PIPE_PREFIX, '');
  if (name === pipe || !SAFE_PIPE_NAME.test(name)) throw new Error('refusing to tighten a pipe with an unsafe name');
  const root = env.SystemRoot && SAFE_SYSTEM_ROOT.test(env.SystemRoot) && !env.SystemRoot.includes('..') ? env.SystemRoot : 'C:\\Windows';
  return {
    file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', TIGHTEN_SCRIPT],
    env: { ...env, [PIPE_NAME_ENV]: name },
  };
}

/** Remove the Everyone and Anonymous entries from the pipe's ACL. Resolves true when done. */
export function restrictPipeToCurrentUser(pipe: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let cmd: PipeAclCommand;
    try {
      cmd = buildPipeAclCommand(pipe);
    } catch {
      resolve(false);
      return;
    }
    execFile(cmd.file, cmd.args, { windowsHide: true, timeout: 20_000, env: cmd.env }, (err) => resolve(!err));
  });
}

const IDLE_MS = 15_000;
const MAX_CONNECTIONS = 8;
const MAX_REQUESTS_PER_CONNECTION = 50;

export class BridgeServer {
  private readonly server: net.Server;
  private readonly pipe: string;
  private readonly restrictAcl: boolean;
  private readonly log: Logger;
  private readonly onAdd: (req: Extract<BridgeRequest, { type: 'add' }>) => Promise<Result>;
  listening = false;
  /** Resolves (true = restricted to the current user) once the ACL clean-up has run. */
  aclReady: Promise<boolean> = Promise.resolve(false);

  constructor(opts: { pipe: string; log: Logger; onAdd: (req: Extract<BridgeRequest, { type: 'add' }>) => Promise<Result>; restrictAcl?: boolean }) {
    this.restrictAcl = opts.restrictAcl ?? true;
    this.pipe = opts.pipe;
    this.log = opts.log;
    this.onAdd = opts.onAdd;
    this.server = net.createServer((sock) => this.onConnection(sock));
    this.server.maxConnections = MAX_CONNECTIONS;
  }

  get pipePath(): string {
    return this.pipe;
  }

  start(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onError = (e: NodeJS.ErrnoException) => {
        this.log.error(`bridge disabled: could not listen on the named pipe (${e.code ?? 'error'})`);
        resolve(false);
      };
      this.server.once('error', onError);
      this.server.listen(this.pipe, () => {
        this.server.off('error', onError);
        this.server.on('error', (e) => this.log.error('bridge server error', e));
        this.listening = true;
        this.log.info('bridge listening on the named pipe');
        if (this.restrictAcl) {
          this.aclReady = restrictPipeToCurrentUser(this.pipe).then((ok) => {
            if (ok) this.log.info('bridge pipe restricted to the current user');
            else this.log.warn('could not tighten the bridge pipe permissions (other users still cannot write to it)');
            return ok;
          });
        }
        resolve(true);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.listening) return resolve();
      this.listening = false;
      this.server.close(() => resolve());
    });
  }

  private onConnection(sock: net.Socket): void {
    sock.setEncoding('utf8');
    sock.setTimeout(IDLE_MS, () => sock.destroy());
    sock.on('error', () => sock.destroy());
    const splitter = new LineSplitter();
    let handled = 0;
    let finished = false; // we have said goodbye: ignore anything still queued
    let chain: Promise<void> = Promise.resolve();

    const reply = (id: string | number | null, ok: boolean, error?: string) => {
      if (!sock.destroyed) sock.write(formatReply(id, ok, error));
    };

    sock.on('data', (chunk: string) => {
      const lines = splitter.push(chunk);
      if (lines === null) {
        if (!finished) reply(null, false, 'line too long');
        finished = true;
        sock.end();
        return;
      }
      for (const line of lines) {
        chain = chain.then(async () => {
          if (sock.destroyed || finished) return;
          if (++handled > MAX_REQUESTS_PER_CONNECTION) {
            finished = true;
            reply(null, false, 'too many requests on one connection');
            sock.end();
            return;
          }
          const parsed = parseBridgeLine(line);
          if (!parsed.ok) {
            reply(parsed.id, false, parsed.error);
            return;
          }
          const req = parsed.request;
          if (req.type === 'ping') {
            reply(req.id, true);
            return;
          }
          try {
            const r = await this.onAdd(req);
            if (r.ok) reply(req.id, true);
            else reply(req.id, false, r.error);
          } catch {
            reply(req.id, false, 'internal error');
          }
        });
      }
    });
  }
}
