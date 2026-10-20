/**
 * Shared token-bucket speed limiter (bytes per second, 0 = unlimited).
 * Share one instance between downloads to cap their combined speed; the limit can
 * be changed at any time and takes effect immediately.
 *
 * Callers `await consume(n)` before using n bytes. The bucket may go into "debt" so a
 * chunk larger than the burst size still works; the caller then sleeps until the
 * debt has been paid off, which keeps the long-run rate exact.
 */
export class Limiter {
  private _limit = 0;
  private tokens = 0;
  private last = performance.now();
  private waiters = new Set<() => void>();

  constructor(bytesPerSec = 0) {
    this.setLimit(bytesPerSec);
  }

  get limit(): number {
    return this._limit;
  }

  setLimit(bytesPerSec: number): void {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) throw new RangeError('limit must be >= 0');
    this._limit = Math.floor(bytesPerSec);
    this.tokens = 0;
    this.last = performance.now();
    for (const wake of [...this.waiters]) wake(); // sleepers re-evaluate against the new limit
  }

  private refill(): void {
    const now = performance.now();
    const capacity = Math.max(this._limit * 0.1, 1); // ~100 ms burst
    this.tokens = Math.min(capacity, this.tokens + ((now - this.last) / 1000) * this._limit);
    this.last = now;
  }

  async consume(n: number, signal?: AbortSignal): Promise<void> {
    if (this._limit <= 0 || n <= 0) return;
    if (signal?.aborted) return;
    this.refill();
    this.tokens -= n;
    if (this.tokens >= 0) return;
    const waitMs = (-this.tokens / this._limit) * 1000;
    const aborted = await this.sleep(waitMs, signal);
    if (aborted) this.tokens += n; // give the bytes back, they were never used
  }

  /** Resolves true if the sleep was cut short by the signal. */
  private sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (aborted: boolean) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
        resolve(aborted);
      };
      const wake = () => finish(false);
      const onAbort = () => finish(true);
      this.waiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(wake, Math.max(0, ms));
    });
  }
}
