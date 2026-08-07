import { describe, it, expect, vi } from 'vitest';
import { parseUsage, UsageCache, type OpenRouterUsage } from '../../src/usage/openrouter-usage';

// The exact shape the live /key endpoint returned, minus the redacted label.
const LIVE_BODY = {
  data: {
    label: 'sk-or-v1-...',
    limit: null,
    limit_remaining: null,
    usage: 0.013673776,
    usage_daily: 0.010498172,
    usage_weekly: 0.013673776,
    usage_monthly: 0.013673776,
    is_free_tier: true,
  },
};

describe('parseUsage', () => {
  it('reads a real response', () => {
    expect(parseUsage(LIVE_BODY)).toEqual({
      total: 0.013673776,
      daily: 0.010498172,
      weekly: 0.013673776,
      monthly: 0.013673776,
      limit: null,
      limitRemaining: null,
      isFreeTier: true,
    });
  });

  it('reads a key that has a limit', () => {
    const usage = parseUsage({ data: { usage: 4, limit: 10, limit_remaining: 6 } });
    expect(usage.limit).toBe(10);
    expect(usage.limitRemaining).toBe(6);
    expect(usage.isFreeTier).toBe(false);
  });

  it('defaults missing numbers to zero rather than NaN', () => {
    expect(parseUsage({ data: {} })).toEqual({
      total: 0,
      daily: 0,
      weekly: 0,
      monthly: 0,
      limit: null,
      limitRemaining: null,
      isFreeTier: false,
    });
  });

  it('survives a body of the wrong shape entirely', () => {
    for (const body of [null, undefined, 'nope', 42, [], {}]) {
      expect(() => parseUsage(body)).not.toThrow();
      expect(parseUsage(body).total).toBe(0);
    }
  });
});

const sample: OpenRouterUsage = {
  total: 1,
  daily: 1,
  weekly: 1,
  monthly: 1,
  limit: null,
  limitRemaining: null,
  isFreeTier: true,
};

describe('UsageCache', () => {
  it('fetches once and serves the cached value inside the TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue(sample);
    let now = 1000;
    const cache = new UsageCache(60_000, fetcher, () => now);

    expect(await cache.get()).toEqual(sample);
    now += 59_000;
    expect(await cache.get()).toEqual(sample);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL expires', async () => {
    const fetcher = vi.fn().mockResolvedValue(sample);
    let now = 1000;
    const cache = new UsageCache(60_000, fetcher, () => now);

    await cache.get();
    now += 61_000;
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent callers onto a single request', async () => {
    const fetcher = vi.fn().mockResolvedValue(sample);
    const cache = new UsageCache(60_000, fetcher, () => 0);

    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('peek never blocks and starts out empty', async () => {
    const fetcher = vi.fn().mockResolvedValue(sample);
    const cache = new UsageCache(60_000, fetcher, () => 0);

    expect(cache.peek()).toBeNull();
    await cache.get();
    expect(cache.peek()).toEqual(sample);
  });

  it('does not cache a failed reading', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const cache = new UsageCache(60_000, fetcher, () => 0);

    expect(await cache.get()).toBeNull();
    expect(await cache.get()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.peek()).toBeNull();
  });

  it('invalidate forces the next get to re-fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(sample);
    const cache = new UsageCache(60_000, fetcher, () => 0);

    await cache.get();
    cache.invalidate();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
