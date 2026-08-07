import { describe, it, expect } from 'vitest';
import { renderPanel, visibleLength } from '../../src/ui/panel';

const plain = (s: string) => s;

function panel(overrides: Partial<Parameters<typeof renderPanel>[0]> = {}) {
  return renderPanel({
    title: 'Robin v0.1.0',
    left: ['left'],
    right: ['right'],
    width: 40,
    leftWidth: 10,
    borderColor: plain,
    ...overrides,
  });
}

describe('visibleLength', () => {
  it('ignores color escapes', () => {
    expect(visibleLength('\x1b[31mred\x1b[39m')).toBe(3);
  });
});

describe('renderPanel', () => {
  it('returns every line at the same visible width', () => {
    for (const width of [60, 80, 100]) {
      const lines = panel({ width });
      for (const line of lines) {
        expect(visibleLength(line)).toBe(width);
      }
    }
  });

  it('right-aligns the title with a single trailing border character', () => {
    const [top] = panel({ title: 'Robin v0.1.0', width: 40 });
    expect(top.endsWith(' Robin v0.1.0 ─╮')).toBe(true);
    expect(top.startsWith('╭─')).toBe(true);
  });

  it('drops a title too long for the border', () => {
    const [top] = panel({ title: 'x'.repeat(40), width: 40 });
    expect(top).toBe(`╭${'─'.repeat(38)}╮`);
  });

  it('pads the shorter column so both sides produce equal rows', () => {
    const lines = panel({ left: ['a', 'b', 'c'], right: ['1'] });
    // top + 3 rows + bottom
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain('c');
  });

  it('pads when the right column is the longer one', () => {
    const lines = panel({ left: ['a'], right: ['1', '2', '3'] });
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain('3');
  });

  it('truncates a cell that overflows its own column', () => {
    const lines = panel({ left: ['abcdefghijklmnop'], right: [''], leftWidth: 10 });
    expect(lines[1]).toContain('abcdefghi…');
    expect(lines[1]).not.toContain('j');
  });

  it('truncates on visible characters, not escape sequences', () => {
    const colored = `\x1b[31m${'a'.repeat(20)}\x1b[39m`;
    const lines = panel({ left: [colored], right: [''], leftWidth: 10 });
    expect(visibleLength(lines[1])).toBe(40);
    expect(lines[1].replace(/\x1b\[[0-9;]*m/g, '')).toContain(`${'a'.repeat(9)}…`);
  });

  it('applies borderColor to the frame', () => {
    const lines = panel({ borderColor: (s) => `<${s}>` });
    expect(lines[0].startsWith('<╭')).toBe(true);
    expect(lines[lines.length - 1].startsWith('<╰')).toBe(true);
    expect(lines[1].startsWith('<│>')).toBe(true);
  });

  it('supports a single stacked column', () => {
    const lines = panel({ left: ['a', '', 'b'], right: [], leftWidth: 36, width: 40 });
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(visibleLength(line)).toBe(40);
    }
  });
});
