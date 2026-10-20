import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../app/redact.ts';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Plain-text daily log files in <userData>/logs. Every message goes through redact() first, so
 * cookies, tokens and query strings never reach the disk. Old files (older than 14 days) are removed.
 */
export class Logger {
  private readonly dir: string;
  private readonly echo: boolean;
  private chain: Promise<void> = Promise.resolve();

  constructor(dir: string, echo: boolean) {
    this.dir = dir;
    this.echo = echo;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.prune();
    } catch {
      /* logging must never stop the app */
    }
  }

  info(msg: string): void {
    this.write('info', msg);
  }
  warn(msg: string): void {
    this.write('warn', msg);
  }
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : err !== undefined ? String(err) : '';
    this.write('error', detail ? `${msg} (${detail})` : msg);
  }

  /** Resolves when everything queued so far is on disk. */
  flush(): Promise<void> {
    return this.chain;
  }

  private write(level: LogLevel, msg: string): void {
    const now = new Date();
    const line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(msg).replace(/[\r\n]+/g, ' ')}\n`;
    if (this.echo) process.stdout.write(line);
    const file = path.join(this.dir, `sareea-${now.toISOString().slice(0, 10)}.log`);
    this.chain = this.chain.then(() => fs.promises.appendFile(file, line).catch(() => undefined));
  }

  private prune(): void {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^sareea-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const p = path.join(this.dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}
