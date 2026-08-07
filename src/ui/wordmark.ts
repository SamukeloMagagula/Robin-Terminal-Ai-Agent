import chalk from 'chalk';
import { GRADIENT } from './theme.js';

// 9-row block glyphs, each row a fixed 9-char-wide string.
const ROBIN_LETTERS: Record<string, string[]> = {
  R: [
    '█████████',
    '██     ██',
    '██     ██',
    '██     ██',
    '█████████',
    '██  ██   ',
    '██   ██  ',
    '██    ██ ',
    '██     ██',
  ],
  O: [
    '█████████',
    '██     ██',
    '██     ██',
    '██     ██',
    '██     ██',
    '██     ██',
    '██     ██',
    '██     ██',
    '█████████',
  ],
  B: [
    '█████████',
    '██     ██',
    '██     ██',
    '██     ██',
    '█████████',
    '██     ██',
    '██     ██',
    '██     ██',
    '█████████',
  ],
  I: [
    '█████████',
    '    █    ',
    '    █    ',
    '    █    ',
    '    █    ',
    '    █    ',
    '    █    ',
    '    █    ',
    '█████████',
  ],
  N: [
    '██     ██',
    '███    ██',
    '████   ██',
    '██ ██  ██',
    '██  ██ ██',
    '██   ████',
    '██    ███',
    '██     ██',
    '██     ██',
  ],
};

const ROW_COUNT = 9;

export const WORDMARK_WIDTH = 9 * 5 + 4; // 5 letters, 9 cols each, 4 single-space gaps

// Each row steps further along the gradient, so the mark fades top to bottom
// rather than left to right the way gradientText() colors inline text.
function rowColor(row: number): (s: string) => string {
  const index = Math.min(Math.floor((row / ROW_COUNT) * GRADIENT.length), GRADIENT.length - 1);
  return chalk.hex(GRADIENT[index]);
}

export function buildWordmark(): string[] {
  const letters = 'ROBIN'.split('');
  const rows: string[] = [];
  for (let row = 0; row < ROW_COUNT; row++) {
    const rowText = letters.map((letter) => ROBIN_LETTERS[letter][row]).join(' ');
    rows.push(rowColor(row)(rowText));
  }
  return rows;
}

/** Fallback for terminals too narrow to fit the block glyphs. */
export function buildPlainWordmark(): string[] {
  return [chalk.hex(GRADIENT[0]).bold('ROBIN')];
}
