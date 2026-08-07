import chalk from 'chalk';

// A hooded cowl: pointed ears, an eye box with two lenses, cheek accents, tapered jaw.
export const COWL_WIDTH = 25;

export function buildCowl(): string[] {
  const rows = [
    `       /\\       /\\       `,
    `      /  \\_____/  \\      `,
    `     /   ╭───────╮  \\    `,
    `    /    │  ${chalk.redBright('●')}  ${chalk.redBright('●')}  │   \\  `,
    `   █     │         │    █`,
    `    \\    ╰───────╯    /  `,
    `     \\_______________/   `,
    `         ▀▀▀▀▀▀▀▀▀       `,
  ];
  return rows.map((row) => chalk.whiteBright(row));
}
