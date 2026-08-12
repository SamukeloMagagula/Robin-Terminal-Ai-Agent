import chalk from 'chalk';
import type { Provider } from '../providers/types.js';
import { mutedColor, divider } from '../ui/theme.js';
import {
  buildChecks,
  runChecks,
  blockingFailures,
  type CheckStatus,
  type CompletedCheck,
} from '../startup/preflight.js';

const ICONS: Record<CheckStatus, string> = {
  ok: chalk.green('✓'),
  warn: chalk.yellow('!'),
  fail: chalk.red('✖'),
};

const LABEL_WIDTH = 18;

export function renderCheck(result: CompletedCheck): string[] {
  const lines = [`  ${ICONS[result.status]} ${result.label.padEnd(LABEL_WIDTH)} ${result.detail}`];
  if (result.remedy) {
    lines.push(mutedColor(`      → ${result.remedy}`));
  }
  return lines;
}

/**
 * `robin doctor` — one command that answers "why won't this run here?".
 *
 * Exits non-zero when a critical check fails so it is usable as a gate in a
 * setup script or CI job, not just something to read.
 */
export async function runDoctor(providers: Provider[]): Promise<void> {
  console.log(chalk.bold('Robin preflight'));
  console.log(divider());

  const results = await runChecks(buildChecks({ providers }));
  for (const result of results) {
    for (const line of renderCheck(result)) console.log(line);
  }

  console.log(divider());

  const blocking = blockingFailures(results);
  const warnings = results.filter((r) => r.status === 'warn');

  if (blocking.length > 0) {
    console.log(chalk.red(`${blocking.length} blocking problem(s) — Robin will not start until these are fixed.`));
    process.exitCode = 1;
    return;
  }
  if (warnings.length > 0) {
    console.log(chalk.yellow(`Ready, with ${warnings.length} warning(s).`));
    return;
  }
  console.log(chalk.green('All checks passed.'));
}
