/**
 * Sliding-window rate limiter (in-memory)
 * Tracks timestamps of recent calls and rejects when window limit is exceeded.
 */

export interface RateLimiterConfig {
  /** Max calls allowed in the window */
  maxCalls: number;
  /** Window size in milliseconds */
  windowMs: number;
}

export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxCalls: number;
  private readonly windowMs: number;

  constructor(config: RateLimiterConfig) {
    this.maxCalls = config.maxCalls;
    this.windowMs = config.windowMs;
  }

  /**
   * Check if a call is allowed. If allowed, records it and returns true.
   * If rate limit exceeded, returns false.
   */
  tryAcquire(): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Remove expired timestamps
    this.timestamps = this.timestamps.filter(t => t > windowStart);

    if (this.timestamps.length >= this.maxCalls) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  /** Number of calls remaining in the current window */
  remaining(): number {
    const windowStart = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter(t => t > windowStart);
    return Math.max(0, this.maxCalls - this.timestamps.length);
  }
}

const ONE_MINUTE = 60_000;

/**
 * Creates separate read/write rate limiters.
 * Defaults: 60 reads/min, 10 writes/min.
 */
export function createRateLimiters(options?: {
  readLimit?: number;
  writeLimit?: number;
}) {
  return {
    read: new RateLimiter({
      maxCalls: options?.readLimit ?? 60,
      windowMs: ONE_MINUTE,
    }),
    write: new RateLimiter({
      maxCalls: options?.writeLimit ?? 10,
      windowMs: ONE_MINUTE,
    }),
  };
}
