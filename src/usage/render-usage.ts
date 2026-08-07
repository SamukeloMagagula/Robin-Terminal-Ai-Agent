import chalk from 'chalk';
import { mutedColor } from '../ui/theme.js';
import { accountBalance, type OpenRouterUsage } from './openrouter-usage.js';

/**
 * Small amounts need more decimals than large ones. Real balances here are
 * fractions of a cent; rounding $0.0137 to "$0.01" would leave the status line
 * unchanged for days, hiding the movement it exists to show.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  const sign = amount < 0 ? '-' : '';
  const value = Math.abs(amount);
  if (value < 0.1) return `${sign}$${value.toFixed(4)}`;
  if (value < 1) return `${sign}$${value.toFixed(3)}`;
  return `${sign}$${value.toFixed(2)}`;
}

const BAR_WIDTH = 10;

/** Green under half, amber past half, red past 80%. */
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

/** Percentage of this key's cap consumed, or null when the key is uncapped. */
export function keyLimitPercent(usage: OpenRouterUsage): number | null {
  if (usage.keyLimit === null || usage.keyLimit <= 0) return null;
  return (usage.keyTotal / usage.keyLimit) * 100;
}

/**
 * One line for the divider between turns.
 *
 * Every segment is labelled with what the API actually measures. "UTC day" is
 * not pedantry: the window rolls over at 00:00 UTC, which is not midnight for
 * most people, so calling it "today" would be wrong for part of every day.
 */
export function renderUsageLine(usage: OpenRouterUsage): string {
  const segments: string[] = [
    `💳 ${formatUsd(usage.keyUtcDay)} UTC day`,
    `${formatUsd(usage.keyTotal)} this key`,
  ];

  const percent = keyLimitPercent(usage);
  if (percent !== null) {
    const color = usageColor(percent);
    segments.push(`${color(usageBar(percent))} ${color(`${Math.round(percent)}%`)} of key cap`);
  }

  const balance = accountBalance(usage);
  if (balance !== null) {
    segments.push(`${formatUsd(balance)} account balance`);
  }

  return mutedColor(segments.join('  ·  '));
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(18)}${chalk.whiteBright(value)}`;
}

/** Fuller breakdown for `/usage`, where there is room to label every figure precisely. */
export function renderUsageReport(usage: OpenRouterUsage): string {
  const lines: string[] = [mutedColor('OpenRouter — this API key')];

  lines.push(row('UTC day', formatUsd(usage.keyUtcDay)));
  lines.push(row('UTC week', formatUsd(usage.keyUtcWeek)) + mutedColor('   (from Monday)'));
  lines.push(row('UTC month', formatUsd(usage.keyUtcMonth)));
  lines.push(row('All time', formatUsd(usage.keyTotal)));

  if (usage.byokTotal > 0) {
    lines.push(row('BYOK all time', formatUsd(usage.byokTotal)));
  }

  const percent = keyLimitPercent(usage);
  if (percent !== null && usage.keyLimit !== null) {
    const color = usageColor(percent);
    lines.push(
      `  ${'Key cap'.padEnd(18)}${color(usageBar(percent))} ${color(`${Math.round(percent)}%`)} of ${formatUsd(usage.keyLimit)}`
    );
    if (usage.keyLimitRemaining !== null) {
      lines.push(row('Cap remaining', formatUsd(usage.keyLimitRemaining)));
    }
  } else {
    lines.push(`  ${'Key cap'.padEnd(18)}${mutedColor('none set')}`);
  }

  if (usage.expiresAt) {
    lines.push(`  ${'Key expires'.padEnd(18)}${mutedColor(usage.expiresAt)}`);
  }

  lines.push('');
  if (usage.account) {
    const balance = usage.account.purchased - usage.account.used;
    lines.push(mutedColor('Account (all keys)'));
    lines.push(row('Credits purchased', formatUsd(usage.account.purchased)));
    lines.push(row('Credits used', formatUsd(usage.account.used)));
    lines.push(row('Balance', formatUsd(balance)));
  } else {
    lines.push(mutedColor('Account totals unavailable — the /credits call did not succeed.'));
  }

  // Stated as what the API reports, not as a prediction about what will fail.
  lines.push('');
  lines.push(
    mutedColor(
      usage.hasEverPurchasedCredits
        ? 'OpenRouter reports credits have been purchased on this account before.'
        : 'OpenRouter reports no credits have ever been purchased on this account.'
    )
  );

  return lines.join('\n');
}
