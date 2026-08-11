import chalk from 'chalk';
import { GRADIENT } from '../theme.js';
import { buildCowl } from '../cowl.js';
import { arcCap } from './frame.js';

/** Width of the full reticle, including its outer arcs. */
export const RETICLE_WIDTH = 34;
/** Width of the fallback used when the terminal is too narrow for the above. */
export const COMPACT_RETICLE_WIDTH = 25;

const outer = chalk.hex(GRADIENT[0]);
const mid = chalk.hex(GRADIENT[1]);
const inner = chalk.hex(GRADIENT[2]);

/**
 * The cowl ringed by concentric arcs.
 *
 * The cowl is Robin's identity and predates this screen, so the reticle wraps
 * it rather than replacing it — the bat reads as the thing being tracked. The
 * rings use successive gradient stops so depth comes from hue rather than from
 * more glyphs, which keeps the whole assembly legible at 34 columns.
 *
 * `status` is the word set into the lower arc.
 */
export function buildReticle(status: string): string[] {
  const cowl = buildCowl();

  const rows: string[] = [
    arcCap('', RETICLE_WIDTH, true),
    `  ${outer('╭' + '─'.repeat(RETICLE_WIDTH - 6) + '╮')}  `,
    ` ${outer('│')}  ${mid('╭' + '─'.repeat(RETICLE_WIDTH - 10) + '╮')}  ${outer('│')} `,
  ];

  // The cowl sits inside the innermost ring, with a crosshair struck through
  // the middle row so the rings read as an instrument rather than a frame.
  cowl.forEach((line, i) => {
    const isCentre = i === Math.floor(cowl.length / 2);
    const left = isCentre ? outer('─┼─') : ` ${outer('│')} `;
    const right = isCentre ? outer('─┼─') : ` ${outer('│')} `;
    rows.push(`${left}${inner('│')} ${line} ${inner('│')}${right}`);
  });

  rows.push(
    ` ${outer('│')}  ${mid('╰' + '─'.repeat(RETICLE_WIDTH - 10) + '╯')}  ${outer('│')} `,
    `  ${outer('╰' + '─'.repeat(RETICLE_WIDTH - 6) + '╯')}  `,
    arcCap(status, RETICLE_WIDTH, false)
  );

  return rows;
}

/**
 * A three-line arc for terminals too narrow for the full assembly.
 *
 * Keeps the motif without the rings: dropping to the bare cowl would lose the
 * HUD entirely at exactly the widths where it still fits.
 */
export function buildCompactReticle(status: string): string[] {
  const width = COMPACT_RETICLE_WIDTH;
  const core = '((( ● )))';
  // All three rows are exactly `width`, so the assembly reads as one object
  // rather than three loose strokes.
  const inside = width - 6; // the two `──┤` / `├──` brackets
  const left = Math.floor((inside - core.length) / 2);
  const right = inside - core.length - left;

  return [
    arcCap('', width, true),
    outer('──┤') +
      ' '.repeat(Math.max(0, left)) +
      inner(core) +
      ' '.repeat(Math.max(0, right)) +
      outer('├──'),
    arcCap(status, width, false),
  ];
}
