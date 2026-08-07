import chalk from 'chalk';
import { mutedColor } from '../ui/theme.js';
import type { OpenRouterUsage } from './openrouter-usage.js';

/**
 * Small amounts need more decimals than large ones. Real balances here are
 * fractions of a cent — $0.0137 rendered as "$0.01" would sit unchanged on the
 * status line for days, hiding every bit of movement it exists to show.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount < 0.1) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

const BAR_WIDTH = 10;

/** Green under half, amber past half, red past 80% — the thresholds from the reference statusline. */
export function usageColor(percent: number): (s: string) => string {
  if (percent >= 80) return chalk.red;
  if (percent >= 50) return chalk.yellow;
  return chalk.green;
}

export function usageBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/** Percentage of the key's limit consumed, or null when the key has no limit. */
export function limitPercent(usage: OpenRouterUsage): number | null {
  if (usage.limit === null || usage.limit <= 0) return null;
  return (usage.total / usage.limit) * 100;
}

/**
 * One-line summary for the divider between turns. Kept short deliberately —
 * it prints after every message, so it has to be scannable, not complete.
 */
export function renderUsageLine(usage: OpenRouterUsage): string {
  const segments: string[] = [`💳 ${formatUsd(usage.daily)} today`, `${formatUsd(usage.total)} total`];

  const percent = limitPercent(usage);
  if (percent !== null) {
    const color = usageColor(percent);
    segments.push(`${color(usageBar(percent))} ${color(`${Math.round(percent)}%`)} of limit`);
  } else if (usage.isFreeTier) {
    segments.push('free tier');
  }

  return mutedColor(segments.join('  ·  '));
}

/** Fuller breakdown for `/usage`, where there is room for every figure. */
export function renderUsageReport(usage: OpenRouterUsage): string {
  const rows: [string, string][] = [
    ['Today', formatUsd(usage.daily)],
    ['This week', formatUsd(usage.weekly)],
    ['This month', formatUsd(usage.monthly)],
    ['All time', formatUsd(usage.total)],
  ];

  const lines = [mutedColor('OpenRouter usage')];
  for (const [label, value] of rows) {
    lines.push(`  ${label.padEnd(12)}${chalk.whiteBright(value)}`);
  }

  const percent = limitPercent(usage);
  if (percent !== null && usage.limit !== null) {
    const color = usageColor(percent);
    lines.push(
      `  ${'Limit'.padEnd(12)}${color(usageBar(percent))} ${color(`${Math.round(percent)}%`)} of ${formatUsd(usage.limit)}`
    );
    if (usage.limitRemaining !== null) {
      lines.push(`  ${'Remaining'.padEnd(12)}${chalk.whiteBright(formatUsd(usage.limitRemaining))}`);
    }
  } else {
    lines.push(`  ${'Limit'.padEnd(12)}${mutedColor('none set on this key')}`);
  }

  if (usage.isFreeTier) {
    lines.push(
      mutedColor('  Free tier — paid models will refuse with 402 until you add credits.')
    );
  }

  return lines.join('\n');
}
