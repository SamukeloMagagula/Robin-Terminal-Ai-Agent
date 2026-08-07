import { describe, it, expect } from 'vitest';
import { buildWordmark, buildPlainWordmark, WORDMARK_WIDTH } from '../../src/ui/wordmark';
import { visibleLength } from '../../src/ui/panel';

describe('buildWordmark', () => {
  it('returns nine rows', () => {
    expect(buildWordmark()).toHaveLength(9);
  });

  it('renders every row at WORDMARK_WIDTH', () => {
    for (const row of buildWordmark()) {
      expect(visibleLength(row)).toBe(WORDMARK_WIDTH);
    }
  });

  it('spells ROBIN with block glyphs', () => {
    const stripped = buildWordmark().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''));
    // The I glyph is the only one with a bare single-column stem.
    expect(stripped[1]).toContain('    █    ');
    expect(stripped[0]).toBe('█'.repeat(9) + ' ' + '█'.repeat(9) + ' ' + '█'.repeat(9) + ' ' + '█'.repeat(9) + ' ' + '██     ██');
  });
});

describe('buildPlainWordmark', () => {
  it('is a single ROBIN line', () => {
    const rows = buildPlainWordmark();
    expect(rows).toHaveLength(1);
    expect(rows[0].replace(/\x1b\[[0-9;]*m/g, '')).toBe('ROBIN');
  });
});
