import { describe, it, expect } from 'vitest';
import {
  formatUsd,
  usageBar,
  keyLimitPercent,
  renderUsageLine,
  renderUsageReport,
} from '../../src/usage/render-usage';
import type { OpenRouterUsage } from '../../src/usage/openrouter-usage';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function usage(overrides: Partial<OpenRouterUsage> = {}): OpenRouterUsage {
  return {
    keyTotal: 0.013673776,
    keyUtcDay: 0.010498172,
    keyUtcWeek: 0.013673776,
    keyUtcMonth: 0.013673776,
    keyLimit: null,
    keyLimitRemaining: null,
    byokTotal: 0,
    expiresAt: '2026-09-05T09:48:00.011Z',
    hasEverPurchasedCredits: false,
    account: { purchased: 0, used: 0.013673776 },
    ...overrides,
  };
}

describe('formatUsd', () => {
  it('keeps four decimals below ten cents', () => {
    expect(formatUsd(0.013673776)).toBe('$0.0137');
    expect(formatUsd(0.010498172)).toBe('$0.0105');
  });

  it('uses three decimals below a dollar', () => {
    expect(formatUsd(0.42)).toBe('$0.420');
  });

  it('uses cents at a dollar and above', () => {
    expect(formatUsd(12.3456)).toBe('$12.35');
  });

  it('renders zero plainly', () => {
    expect(formatUsd(0)).toBe('$0');
  });

  // A spent-down account has a negative balance; it must not render as "$0.0137".
  it('keeps the sign on negative amounts', () => {
    expect(formatUsd(-0.013673776)).toBe('-$0.0137');
    expect(formatUsd(-5)).toBe('-$5.00');
  });
});

describe('usageBar', () => {
  it('fills proportionally', () => {
    expect(usageBar(0, 10)).toBe('░░░░░░░░░░');
    expect(usageBar(50, 10)).toBe('█████░░░░░');
    expect(usageBar(100, 10)).toBe('██████████');
  });

  it('clamps out-of-range input', () => {
    expect(usageBar(-20, 10)).toBe('░░░░░░░░░░');
    expect(usageBar(300, 10)).toBe('██████████');
  });
});

describe('keyLimitPercent', () => {
  it('is null when the key is uncapped', () => {
    expect(keyLimitPercent(usage({ keyLimit: null }))).toBeNull();
  });

  it('is null for a zero cap rather than dividing by zero', () => {
    expect(keyLimitPercent(usage({ keyLimit: 0 }))).toBeNull();
  });

  it('measures key total against the key cap', () => {
    expect(keyLimitPercent(usage({ keyTotal: 2.5, keyLimit: 10 }))).toBe(25);
  });
});

describe('renderUsageLine', () => {
  // The window is the UTC day, which is not midnight for most of the world.
  // Labelling it "today" would be wrong for part of every day.
  it('labels the daily figure as the UTC day, not "today"', () => {
    const line = strip(renderUsageLine(usage()));
    expect(line).toContain('$0.0105 UTC day');
    expect(line).not.toMatch(/\btoday\b/);
  });

  it('scopes the all-time figure to the key, not the account', () => {
    const line = strip(renderUsageLine(usage()));
    expect(line).toContain('$0.0137 this key');
    expect(line).not.toMatch(/\btotal\b/);
  });

  it('shows account balance when the account call succeeded', () => {
    expect(strip(renderUsageLine(usage()))).toContain('-$0.0137 account balance');
  });

  it('omits account balance when the account call failed', () => {
    expect(strip(renderUsageLine(usage({ account: null })))).not.toContain('account balance');
  });

  // "free tier" is a plan name; is_free_tier is a purchase-history flag.
  it('never calls the account a tier', () => {
    for (const flag of [true, false]) {
      const line = strip(renderUsageLine(usage({ hasEverPurchasedCredits: flag })));
      expect(line.toLowerCase()).not.toContain('tier');
    }
  });

  it('shows a bar against the key cap when one is set', () => {
    const line = strip(renderUsageLine(usage({ keyTotal: 5, keyLimit: 10 })));
    expect(line).toContain('50% of key cap');
  });

  it('is a single line', () => {
    expect(renderUsageLine(usage()).split('\n')).toHaveLength(1);
  });
});

describe('renderUsageReport', () => {
  it('labels every window as UTC and names the week start', () => {
    const report = strip(renderUsageReport(usage()));
    expect(report).toContain('UTC day');
    expect(report).toContain('UTC week');
    expect(report).toContain('from Monday');
    expect(report).toContain('UTC month');
  });

  it('separates key figures from account figures', () => {
    const report = strip(renderUsageReport(usage()));
    expect(report).toContain('this API key');
    expect(report).toContain('Account (all keys)');
    expect(report).toContain('Credits purchased');
    expect(report).toContain('Credits used');
  });

  it('reports a negative balance as negative', () => {
    expect(strip(renderUsageReport(usage()))).toContain('-$0.0137');
  });

  it('states the purchase-history flag as what the API reports', () => {
    expect(strip(renderUsageReport(usage({ hasEverPurchasedCredits: false })))).toContain(
      'no credits have ever been purchased'
    );
    expect(strip(renderUsageReport(usage({ hasEverPurchasedCredits: true })))).toContain(
      'credits have been purchased'
    );
  });

  // The old version asserted "paid models will refuse with 402", an inference
  // about future behaviour that the API never stated.
  it('does not predict what requests will fail', () => {
    const report = strip(renderUsageReport(usage()));
    expect(report).not.toContain('402');
    expect(report).not.toContain('will refuse');
  });

  it('says so plainly when account totals are unavailable', () => {
    expect(strip(renderUsageReport(usage({ account: null })))).toContain(
      'Account totals unavailable'
    );
  });

  it('shows key expiry when the API gives one', () => {
    expect(strip(renderUsageReport(usage()))).toContain('2026-09-05');
  });

  it('hides BYOK when it is zero and shows it when it is not', () => {
    expect(strip(renderUsageReport(usage()))).not.toContain('BYOK');
    expect(strip(renderUsageReport(usage({ byokTotal: 1.5 })))).toContain('BYOK');
  });
});
