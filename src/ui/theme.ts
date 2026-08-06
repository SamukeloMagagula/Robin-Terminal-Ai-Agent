import chalk from 'chalk';

const GRADIENT = ['#22d3ee', '#38bdf8', '#60a5fa', '#818cf8'];

export function gradientText(text: string): string {
  return text
    .split('')
    .map((char, i) => chalk.hex(GRADIENT[i % GRADIENT.length])(char))
    .join('');
}

export const userColor = chalk.cyanBright;
export const assistantColor = chalk.hex('#818cf8');
export const errorColor = chalk.red;
export const mutedColor = chalk.gray;

export function box(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const top = mutedColor(`╭${'─'.repeat(width + 2)}╮`);
  const bottom = mutedColor(`╰${'─'.repeat(width + 2)}╯`);
  const middle = lines.map((l) => `${mutedColor('│ ')}${l.padEnd(width)}${mutedColor(' │')}`);
  return [top, ...middle, bottom].join('\n');
}

const DIVIDER_WIDTH = 48;

export function divider(): string {
  return mutedColor('─'.repeat(DIVIDER_WIDTH));
}
