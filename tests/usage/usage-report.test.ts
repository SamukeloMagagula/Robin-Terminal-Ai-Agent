import { describe, it, expect } from 'vitest';
import { buildUsageReport } from '../../src/usage/usage-report';
import type { UsageEntry } from '../../src/usage/usage-log';

const entry = (overrides: Partial<UsageEntry>): UsageEntry => ({
  ts: '2026-08-21T09:00:00.000Z',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 1000,
  outputTokens: 100,
  estimatedCostUsd: 0.0045,
  ...overrides,
});

// A Friday, so "this week" runs Monday 2026-08-17 through Sunday 2026-08-23.
const NOW = new Date('2026-08-21T12:00:00.000Z');

describe('buildUsageReport', () => {
  it('counts an entry from today in today, week, and month', () => {
    const report = buildUsageReport([entry({ ts: '2026-08-21T09:00:00.000Z' })], NOW);

    expect(report.today.turns).toBe(1);
    expect(report.week.turns).toBe(1);
    expect(report.month.turns).toBe(1);
    expect(report.today.inputTokens).toBe(1000);
    expect(report.today.estimatedCostUsd).toBeCloseTo(0.0045, 6);
  });

  it('excludes an entry from before this UTC week, but keeps it in the month', () => {
    // Monday 2026-08-17 00:00 UTC is the start of NOW's week — Sat 08-15 is not in it.
    const report = buildUsageReport([entry({ ts: '2026-08-15T09:00:00.000Z' })], NOW);

    expect(report.today.turns).toBe(0);
    expect(report.week.turns).toBe(0);
    expect(report.month.turns).toBe(1);
  });

  it('excludes an entry from last month entirely', () => {
    const report = buildUsageReport([entry({ ts: '2026-07-30T09:00:00.000Z' })], NOW);

    expect(report.month.turns).toBe(0);
  });

  it('excludes an entry from later the same day but a future turn is impossible — boundary is start of day UTC', () => {
    const report = buildUsageReport([entry({ ts: '2026-08-20T23:59:59.999Z' })], NOW);

    expect(report.today.turns).toBe(0);
    expect(report.week.turns).toBe(1);
  });

  it('sums known costs but counts a null-cost entry in tokens only', () => {
    const report = buildUsageReport(
      [
        entry({ provider: 'ollama', model: 'llama3', estimatedCostUsd: null, inputTokens: 500, outputTokens: 50 }),
        entry({ estimatedCostUsd: 0.01 }),
      ],
      NOW
    );

    expect(report.today.turns).toBe(2);
    expect(report.today.inputTokens).toBe(1500);
    expect(report.today.estimatedCostUsd).toBeCloseTo(0.01, 6);
  });

  it('breaks totals down by provider, all-time', () => {
    const report = buildUsageReport(
      [
        entry({ provider: 'anthropic', ts: '2026-07-01T00:00:00.000Z' }),
        entry({ provider: 'gemini', ts: '2026-08-21T00:00:00.000Z', estimatedCostUsd: 0.002 }),
      ],
      NOW
    );

    expect(report.byProvider.anthropic.turns).toBe(1);
    expect(report.byProvider.gemini.turns).toBe(1);
    expect(report.byProvider.gemini.estimatedCostUsd).toBeCloseTo(0.002, 6);
  });

  it('returns all-zero totals for an empty log', () => {
    const report = buildUsageReport([], NOW);

    expect(report.today).toEqual({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, turns: 0 });
    expect(report.byProvider).toEqual({});
  });
});
