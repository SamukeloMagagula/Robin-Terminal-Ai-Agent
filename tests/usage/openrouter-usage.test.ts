import { describe, it, expect, vi } from 'vitest';
import {
  parseKeyResponse,
  parseCreditsResponse,
  accountBalance,
  UsageCache,
  type OpenRouterUsage,
} from '../../src/usage/openrouter-usage';

// The exact body the live /key endpoint returned, label redacted.
const LIVE_KEY_BODY = {
  data: {
    is_management_key: false,
    is_provisioning_key: false,
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    include_byok_in_limit: false,
    usage: 0.013673776,
    usage_daily: 0.010498172,
    usage_weekly: 0.013673776,
    usage_monthly: 0.013673776,
    byok_usage: 0,
    is_free_tier: true,
    expires_at: '2026-09-05T09:48:00.011Z',
  },
};

const LIVE_CREDITS_BODY = { data: { total_credits: 0, total_usage: 0.013673776 } };

describe('parseKeyResponse', () => {
  it('reads the live response into documented meanings', () => {
    expect(parseKeyResponse(LIVE_KEY_BODY)).toEqual({
      keyTotal: 0.013673776,
      keyUtcDay: 0.010498172,
      keyUtcWeek: 0.013673776,
      keyUtcMonth: 0.013673776,
      keyLimit: null,
      keyLimitRemaining: null,
      byokTotal: 0,
      expiresAt: '2026-09-05T09:48:00.011Z',
      hasEverPurchasedCredits: false,
    });
  });

  // is_free_tier is documented as "whether the user has paid for credits
  // before" — a purchase-history flag. It must not be read as a plan name.
  it('treats is_free_tier:false as having purchased before', () => {
    expect(parseKeyResponse({ data: { is_free_tier: false } }).hasEverPurchasedCredits).toBe(true);
  });

  it('does not claim a purchase when the flag is absent', () => {
    expect(parseKeyResponse({ data: {} }).hasEverPurchasedCredits).toBe(false);
  });

  it('reads a key that has a spending cap', () => {
    const usage = parseKeyResponse({ data: { usage: 4, limit: 10, limit_remaining: 6 } });
    expect(usage.keyLimit).toBe(10);
    expect(usage.keyLimitRemaining).toBe(6);
  });

  it('defaults missing numbers to zero rather than NaN', () => {
    const usage = parseKeyResponse({ data: {} });
    expect(usage.keyTotal).toBe(0);
    expect(usage.keyUtcDay).toBe(0);
    expect(usage.expiresAt).toBeNull();
  });

  it('survives a body of the wrong shape entirely', () => {
    for (const body of [null, undefined, 'nope', 42, [], {}]) {
      expect(() => parseKeyResponse(body)).not.toThrow();
      expect(parseKeyResponse(body).keyTotal).toBe(0);
    }
  });
});

describe('parseCreditsResponse', () => {
  it('reads the live response', () => {
    expect(parseCreditsResponse(LIVE_CREDITS_BODY)).toEqual({
      purchased: 0,
      used: 0.013673776,
    });
  });

  it('survives a malformed body', () => {
    expect(parseCreditsResponse(null)).toEqual({ purchased: 0, used: 0 });
  });
});

describe('accountBalance', () => {
  const base = parseKeyResponse(LIVE_KEY_BODY);

  it('is null when account figures are unavailable', () => {
    expect(accountBalance({ ...base, account: null })).toBeNull();
  });

  it('is purchased minus used, and may be negative', () => {
    expect(accountBalance({ ...base, account: { purchased: 0, used: 0.0137 } })).toBeCloseTo(
      -0.0137
    );
    expect(accountBalance({ ...base, account: { purchased: 10, used: 2.5 } })).toBe(7.5);
  });
});

const sample: OpenRouterUsage = { ...parseKeyResponse(LIVE_KEY_BODY), account: null };

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
