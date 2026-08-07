import { describe, it, expect } from 'vitest';
import {
  formatUsd,
  usageBar,
  limitPercent,
  renderUsageLine,
  renderUsageReport,
} from '../../src/usage/render-usage';
import type { OpenRouterUsage } from '../../src/usage/openrouter-usage';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function usage(overrides: Partial<OpenRouterUsage> = {}): OpenRouterUsage {
  return {
    total: 0.013673776,
    daily: 0.010498172,
    weekly: 0.013673776,
    monthly: 0.013673776,
    limit: null,
    limitRemaining: null,
    isFreeTier: true,
    ...overrides,
  };
}

describe('formatUsd', () => {
  // The real balance is $0.0137 — rounding to cents would show "$0.01" and
  // then "$0.01" again next turn, hiding all movement.
  it('keeps four decimals for sub-cent amounts', () => {
    expect(formatUsd(0.013673776)).toBe('$0.0137');
    expect(formatUsd(0.0001)).toBe('$0.0001');
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

  it('is always the requested width', () => {
    for (const percent of [0, 7, 33, 66, 99, 100]) {
      expect(usageBar(percent, 10)).toHaveLength(10);
    }
  });
});

describe('limitPercent', () => {
  it('is null when the key has no limit', () => {
    expect(limitPercent(usage({ limit: null }))).toBeNull();
  });

  it('is null for a zero limit rather than dividing by zero', () => {
    expect(limitPercent(usage({ limit: 0 }))).toBeNull();
  });

  it('computes a percentage against the limit', () => {
    expect(limitPercent(usage({ total: 2.5, limit: 10 }))).toBe(25);
  });
});

describe('renderUsageLine', () => {
  it('shows today and total spend', () => {
    const line = strip(renderUsageLine(usage()));
    expect(line).toContain('$0.0105 today');
    expect(line).toContain('$0.0137 total');
  });

  it('marks a free-tier key with no limit', () => {
    expect(strip(renderUsageLine(usage()))).toContain('free tier');
  });

  it('shows a bar and percentage when a limit exists', () => {
    const line = strip(renderUsageLine(usage({ total: 5, limit: 10, isFreeTier: false })));
    expect(line).toContain('50% of limit');
    expect(line).toContain('█████░░░░░');
  });

  it('is a single line', () => {
    expect(renderUsageLine(usage()).split('\n')).toHaveLength(1);
  });
});

describe('renderUsageReport', () => {
  it('lists every period', () => {
    const report = strip(renderUsageReport(usage()));
    for (const label of ['Today', 'This week', 'This month', 'All time']) {
      expect(report).toContain(label);
    }
  });

  it('says so when the key has no limit', () => {
    expect(strip(renderUsageReport(usage()))).toContain('none set on this key');
  });

  it('explains why free-tier keys hit 402s', () => {
    expect(strip(renderUsageReport(usage({ isFreeTier: true })))).toContain('402');
  });

  it('shows limit and remaining when both are present', () => {
    const report = strip(
      renderUsageReport(usage({ total: 8, limit: 10, limitRemaining: 2, isFreeTier: false }))
    );
    expect(report).toContain('80% of $10.00');
    expect(report).toContain('Remaining');
    expect(report).toContain('$2.00');
    expect(report).not.toContain('402');
  });
});
