import chalk from 'chalk';

// A hooded cowl: pointed ears, an eye box with two lenses, cheek accents, tapered jaw.
export const COWL_WIDTH = 25;

/**
 * Every row mirrors about column 12, the middle of the 25.
 *
 * The ears were centred and everything below them was not — each row from the
 * brow down sat between half a column and a column and a half to the right, so
 * the face leaned away from the ears above it. Drawn by hand, it is the kind of
 * drift that is invisible glyph by glyph and obvious once the rows are stacked.
 * The eye box, the lenses, the cheeks and the jaw are now placed as mirrored
 * pairs, which is also what keeps the reticle's rings hanging square on it.
 */
export function buildCowl(): string[] {
  const rows = [
    `       /\\       /\\       `,
    `      /  \\_____/  \\      `,
    `     /  ╭───────╮  \\     `,
    `    /   │ ${chalk.redBright('●')}   ${chalk.redBright('●')} │   \\    `,
    `   █    │       │    █   `,
    `    \\   ╰───────╯   /    `,
    `     \\_____________/     `,
    `        ▀▀▀▀▀▀▀▀▀        `,
  ];
  return rows.map((row) => chalk.whiteBright(row));
}
