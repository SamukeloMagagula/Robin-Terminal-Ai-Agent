import type { UsageEntry } from './usage-log.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  turns: number;
}

export interface UsageReport {
  today: UsageTotals;
  /** UTC week, Monday start — same convention as OpenRouter's usage_weekly. */
  week: UsageTotals;
  month: UsageTotals;
  byProvider: Record<string, UsageTotals>;
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, turns: 0 };
}

function add(totals: UsageTotals, entry: UsageEntry): void {
  totals.inputTokens += entry.inputTokens;
  totals.outputTokens += entry.outputTokens;
  totals.turns += 1;
  if (entry.estimatedCostUsd !== null) totals.estimatedCostUsd += entry.estimatedCostUsd;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Monday 00:00 UTC of the week containing `d`. Sunday counts as day 7, not day 0. */
function startOfUtcWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay(); // 1 = Monday .. 7 = Sunday
  day.setUTCDate(day.getUTCDate() - (weekday - 1));
  return day;
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function buildUsageReport(entries: UsageEntry[], now: Date = new Date()): UsageReport {
  const dayStart = startOfUtcDay(now);
  const weekStart = startOfUtcWeek(now);
  const monthStart = startOfUtcMonth(now);

  const report: UsageReport = {
    today: emptyTotals(),
    week: emptyTotals(),
    month: emptyTotals(),
    byProvider: {},
  };

  for (const entry of entries) {
    const ts = new Date(entry.ts);
    if (ts >= dayStart) add(report.today, entry);
    if (ts >= weekStart) add(report.week, entry);
    if (ts >= monthStart) add(report.month, entry);

    if (!report.byProvider[entry.provider]) report.byProvider[entry.provider] = emptyTotals();
    add(report.byProvider[entry.provider], entry);
  }

  return report;
}
