import chalk from 'chalk';
import { GRADIENT, mutedColor } from '../theme.js';
import { visibleLength } from '../panel.js';

const border = chalk.hex(GRADIENT[0]);
const label = chalk.hex(GRADIENT[2]).bold;

/**
 * Corner-bracket chrome rather than a closed box.
 *
 * The reference's defining motif is the interrupted border — brackets at the
 * corners, gaps along the runs — which reads as instrumentation where a
 * complete rectangle reads as a dialog.
 */
export function frameTop(title: string, width: number): string {
  const text = ` ${title} `;
  // `⌐` + dashes + text + `─┐` must total `width`, hence the 3 fixed glyphs.
  const dashes = width - visibleLength(text) - 3;
  if (dashes < 2) return border(`⌐${'─'.repeat(Math.max(0, width - 2))}┐`);
  return border(`⌐${'─'.repeat(dashes)}`) + label(text) + border(`─┐`);
}

export function frameBottom(left: string, right: string, width: number): string {
  const inner = width - 2;
  const leftText = left ? ` ${left} ` : '';
  const rightText = right ? ` ${right} ` : '';
  const dashes = inner - visibleLength(leftText) - visibleLength(rightText) - 2;
  if (dashes < 2) return border(`└${'─'.repeat(Math.max(0, inner))}┘`);
  return (
    border('└──') +
    mutedColor(leftText) +
    border('─'.repeat(dashes)) +
    mutedColor(rightText) +
    border('┘')
  );
}

/**
 * A labelled section rule: `⌐─ TOOLS ────────`.
 *
 * Open at the right, so sections read as regions of one surface rather than as
 * separate boxes stacked on top of each other.
 */
export function sectionRule(title: string, width: number): string {
  const text = ` ${title} `;
  const dashes = width - visibleLength(text) - 2;
  if (dashes < 1) return border(`⌐─${text}`);
  return border('⌐─') + label(text) + border('─'.repeat(dashes));
}

/** A single labelled row inside a section: `PROVIDER   anthropic`. */
export function statRow(name: string, value: string, nameWidth: number): string {
  return ` ${mutedColor(name.padEnd(nameWidth))}${value}`;
}

/** Brackets used above and below the reticle, echoing the reference's arcs. */
export function arcCap(text: string, width: number, top: boolean): string {
  const [openChar, closeChar] = top ? ['◜', '◝'] : ['◟', '◞'];
  const inner = Math.max(0, width - 2);
  if (!text) return border(`${openChar}${'─'.repeat(inner)}${closeChar}`);

  const spaced = ` ${text} `;
  const dashes = inner - visibleLength(spaced);
  const left = Math.floor(dashes / 2);
  const right = dashes - left;
  if (dashes < 2) return border(`${openChar}${'─'.repeat(inner)}${closeChar}`);
  return (
    border(`${openChar}${'─'.repeat(left)}`) +
    label(spaced) +
    border(`${'─'.repeat(right)}${closeChar}`)
  );
}
