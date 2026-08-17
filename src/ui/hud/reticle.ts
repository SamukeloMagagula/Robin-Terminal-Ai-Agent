import chalk from 'chalk';
import { GRADIENT } from '../theme.js';
import { buildCowl } from '../cowl.js';
import { visibleLength } from '../panel.js';
import { arcCap } from './frame.js';

/**
 * Twelve columns of furniture wrap the cowl on every row that contains it:
 * ` │  │ ` on the left and its mirror on the right.
 *
 * Measured rather than typed. This was 34 while the cowl was 25 wide, which
 * needs 37 — so every row through the middle ran a column wide and the inner
 * ring bulged out of the outer one. Nothing failed, because nothing checks a
 * constant against the art it describes; it just looked wrong. Deriving it
 * means editing the cowl cannot silently break the frame around it.
 */
const RETICLE_MARGIN = 12;

const COWL = buildCowl();
const COWL_WIDTH = Math.max(...COWL.map(visibleLength));

/** Width of the full reticle, including its outer arcs. */
export const RETICLE_WIDTH = COWL_WIDTH + RETICLE_MARGIN;
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
  const cowl = COWL;

  const rows: string[] = [
    arcCap('', RETICLE_WIDTH, true),
    `  ${outer('╭' + '─'.repeat(RETICLE_WIDTH - 6) + '╮')}  `,
    ` ${outer('│')}  ${mid('╭' + '─'.repeat(RETICLE_WIDTH - 10) + '╮')}  ${outer('│')} `,
  ];

  // The cowl sits inside the innermost ring, with a crosshair struck through
  // the middle row so the rings read as an instrument rather than a frame.
  //
  // Both margins are four columns, which is what puts the inner bars under the
  // `╭` and `╮` of the ring above: that ring opens at column 4 and closes at
  // RETICLE_WIDTH - 5. The crosshair variants keep the vertical in the same
  // column as the plain ones so the outer ring stays a straight line.
  cowl.forEach((line, i) => {
    const isCentre = i === Math.floor(cowl.length / 2);
    const left = isCentre ? outer('─┼──') : ` ${outer('│')}  `;
    const right = isCentre ? outer('──┼─') : `  ${outer('│')} `;
    // Padded, so a cowl whose lines are not all equal cannot skew the ring.
    const cell = line + ' '.repeat(COWL_WIDTH - visibleLength(line));
    rows.push(`${left}${inner('│')} ${cell} ${inner('│')}${right}`);
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
