import chalk from 'chalk';
import { GRADIENT, mutedColor } from '../theme.js';

const FILLED = '▰';
const EMPTY = '▱';
const SEGMENTS = 5;

const fillColor = chalk.hex(GRADIENT[0]);

/**
 * A five-segment bar, e.g. `▰▰▰▱▱`.
 *
 * `value` is clamped rather than trusted: a count that outran its expected
 * maximum should peg the meter, not print a longer bar and break the column
 * alignment of everything beside it.
 */
export function meter(value: number, max: number, segments: number = SEGMENTS): string {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return mutedColor(EMPTY.repeat(segments));
  }
  const ratio = Math.max(0, Math.min(1, value / max));
  // A non-zero value always shows at least one segment: rounding 1-of-50 down
  // to an empty bar reads as "none", which is a different fact.
  const filled = value > 0 ? Math.max(1, Math.round(ratio * segments)) : 0;
  return fillColor(FILLED.repeat(filled)) + mutedColor(EMPTY.repeat(segments - filled));
}

const COLUMNS = ' ▁▂▃▄▅▆▇█';

/**
 * A sparkline, for the reference's bottom-left column chart.
 *
 * Scaled to the series' own maximum rather than an absolute one, because the
 * shape over time is the readable part — an absolute scale would flatten every
 * real spend history into a row of blanks.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max <= 0) return mutedColor(COLUMNS[1].repeat(values.length));

  return fillColor(
    values
      .map((value) => {
        const clamped = Math.max(0, Math.min(max, value));
        const level = Math.round((clamped / max) * (COLUMNS.length - 2)) + 1;
        return COLUMNS[level];
      })
      .join('')
  );
}
