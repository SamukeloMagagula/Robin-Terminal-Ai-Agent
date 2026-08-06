import chalk from 'chalk';
import { mutedColor } from './theme.js';

const WORD_INDENT = '  ';

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

const WORD_WIDTH = 9 * 5 + 4; // 5 letters, 9 cols each, 4 single-space gaps

function buildWordmark(): string[] {
  const letters = 'ROBIN'.split('');
  const rows: string[] = [];
  for (let row = 0; row < 9; row++) {
    const rowText = letters.map((letter) => ROBIN_LETTERS[letter][row]).join(' ');
    rows.push(`${WORD_INDENT}${chalk.whiteBright(rowText)}`);
  }
  return rows;
}

// A hooded cowl: pointed ears, an eye box with two lenses, cheek accents, tapered jaw.
const MASK_WIDTH = 26;

function buildMask(): string[] {
  const maskIndent = ' '.repeat(WORD_INDENT.length + Math.floor((WORD_WIDTH - MASK_WIDTH) / 2));
  const rows = [
    `${maskIndent}       /\\       /\\        `,
    `${maskIndent}      /  \\_____/  \\       `,
    `${maskIndent}     /   ╭───────╮  \\     `,
    `${maskIndent}    /    │  ${chalk.redBright('●')}  ${chalk.redBright('●')}  │   \\   `,
    `${maskIndent}   █     │         │    █ `,
    `${maskIndent}    \\    ╰───────╯    /   `,
    `${maskIndent}     \\_______________/    `,
    `${maskIndent}         ▀▀▀▀▀▀▀▀▀        `,
  ];
  return rows.map((row) => chalk.whiteBright(row));
}

export function printBanner(): void {
  const lines = [
    '',
    ...buildMask(),
    '',
    ...buildWordmark(),
    '',
    `${WORD_INDENT}${mutedColor('Robin is a terminal agent that lets you run your AI.')}`,
    `${WORD_INDENT}${mutedColor('built by Samukelo "Batman" Magagula')}`,
    '',
  ];
  console.log(lines.join('\n'));
}

const SUBTITLE_WIDTH = 44;

export function printConnectionLine(providerName: string, model: string): void {
  const label = `${providerName} · ${model}`;
  const fillLength = Math.max(SUBTITLE_WIDTH - label.length - 4, 0);
  console.log(`   ${mutedColor('──')} ${label} ${mutedColor('─'.repeat(fillLength))}`);
}
