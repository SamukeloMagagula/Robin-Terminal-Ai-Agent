import { describe, it, expect } from 'vitest';
import { buildCowl, COWL_WIDTH } from '../../src/ui/cowl';
import { visibleLength } from '../../src/ui/panel';

const ESC = String.fromCharCode(27);
function plain(text: string): string {
  return text.split(new RegExp(ESC + '\\[[0-9;]*m', 'g')).join('');
}

/** A glyph and the glyph it becomes when the drawing is flipped. */
const MIRROR: Record<string, string> = {
  '/': '\\',
  '\\': '/',
  '╭': '╮',
  '╮': '╭',
  '╰': '╯',
  '╯': '╰',
};

describe('the cowl', () => {
  it('is the width it says it is', () => {
    for (const row of buildCowl()) {
      expect(visibleLength(row)).toBe(COWL_WIDTH);
    }
  });

  it('mirrors about its centre column', () => {
    // The ears were centred and everything below them was not — each row from
    // the brow down sat up to a column and a half right of centre, so the face
    // leaned away from the ears. Drawn by hand, that drift is invisible glyph
    // by glyph and obvious once the rows are stacked. Checking the mirror
    // catches it on any row, including ones added later.
    for (const [i, row] of buildCowl().entries()) {
      const glyphs = [...plain(row)];
      for (let j = 0; j < glyphs.length; j++) {
        const opposite = glyphs[glyphs.length - 1 - j];
        const expected = MIRROR[glyphs[j]] ?? glyphs[j];
        expect(
          opposite,
          `row ${i} column ${j} is "${glyphs[j]}", so column ${glyphs.length - 1 - j} should be "${expected}"`
        ).toBe(expected);
      }
    }
  });

  it('has both eyes, placed as a pair', () => {
    const eyeRow = buildCowl().map(plain).find((row) => row.includes('●'));
    expect(eyeRow).toBeDefined();

    const columns = [...(eyeRow as string)].flatMap((c, i) => (c === '●' ? [i] : []));
    expect(columns).toHaveLength(2);
    // Equidistant from the centre, which is what makes the face read as facing
    // forward rather than turned.
    expect(columns[0] + columns[1]).toBe(COWL_WIDTH - 1);
  });
});
