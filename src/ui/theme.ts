import chalk from 'chalk';
import { visibleLength } from './panel.js';

export const GRADIENT = ['#22d3ee', '#38bdf8', '#60a5fa', '#818cf8'];

export const assistantColor = chalk.hex('#818cf8');
export const errorColor = chalk.red;
export const mutedColor = chalk.gray;

// Raw ANSI codes (no auto-reset) matching userColor, for the readline prompt.
// chalk always appends a reset after styled text, which would turn the
// color off right as the user starts typing; printing the open code alone
// keeps the terminal's own echo of typed characters colored until we
// explicitly reset it once the user presses Enter.
export const USER_INPUT_COLOR = '\x1b[96m';
export const RESET_COLOR = '\x1b[39m';

export function box(lines: string[]): string {
  // Measured on visible width, not string length: a line containing colour
  // escapes would otherwise be counted as far wider than it draws, and the
  // border would sit well past the text.
  const width = Math.max(...lines.map(visibleLength));
  const top = mutedColor(`╭${'─'.repeat(width + 2)}╮`);
  const bottom = mutedColor(`╰${'─'.repeat(width + 2)}╯`);
  const middle = lines.map((l) => {
    const padding = ' '.repeat(Math.max(width - visibleLength(l), 0));
    return `${mutedColor('│ ')}${l}${padding}${mutedColor(' │')}`;
  });
  return [top, ...middle, bottom].join('\n');
}

const MAX_RULE_WIDTH = 100;
const MIN_RULE_WIDTH = 24;
const DEFAULT_RULE_WIDTH = 80;

/**
 * Width for full-width rules, matching how the banner sizes itself. A fixed
 * width left the divider visibly shorter than the usage line printed directly
 * beneath it.
 */
export function ruleWidth(): number {
  const columns = process.stdout.columns ?? DEFAULT_RULE_WIDTH;
  return Math.max(Math.min(columns - 2, MAX_RULE_WIDTH), MIN_RULE_WIDTH);
}

export function divider(): string {
  return mutedColor('─'.repeat(ruleWidth()));
}
