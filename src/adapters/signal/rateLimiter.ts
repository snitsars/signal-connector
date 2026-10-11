/**
 * Outbound rate limiter (spine AD-7). Spaces sends by a minimum interval and
 * caps the number per rolling minute, so the bot never looks like a broadcaster.
 * `now` and `sleep` are injectable for deterministic tests.
 */
export interface RateLimiterOptions {
  minIntervalMs: number;
  maxPerMinute: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private last = Number.NEGATIVE_INFINITY;
  private window: number[] = [];

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private computeWait(now: number): number {
    this.window = this.window.filter((ts) => now - ts < WINDOW_MS);
    const intervalWait =
      this.last === Number.NEGATIVE_INFINITY ? 0 : this.last + this.opts.minIntervalMs - now;
    const capWait =
      this.window.length >= this.opts.maxPerMinute && this.window[0] !== undefined
        ? this.window[0] + WINDOW_MS - now
        : 0;
    return Math.max(intervalWait, capWait, 0);
  }

  /** Resolves when it is safe to send. */
  async acquire(): Promise<void> {
    let wait = this.computeWait(this.now());
    while (wait > 0) {
      await this.sleep(wait);
      wait = this.computeWait(this.now());
    }
    const now = this.now();
    this.last = now;
    this.window.push(now);
  }
}
