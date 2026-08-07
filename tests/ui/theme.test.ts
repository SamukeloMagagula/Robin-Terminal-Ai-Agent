import { describe, it, expect, afterEach } from 'vitest';
import chalk from 'chalk';
import { box, divider, ruleWidth } from '../../src/ui/theme';
import { visibleLength } from '../../src/ui/panel';

const originalColumns = process.stdout.columns;

function setColumns(value: number | undefined) {
  Object.defineProperty(process.stdout, 'columns', { value, configurable: true });
}

afterEach(() => {
  setColumns(originalColumns);
});

describe('ruleWidth', () => {
  it('tracks the terminal, leaving room for the indent', () => {
    setColumns(80);
    expect(ruleWidth()).toBe(78);
  });

  it('caps on very wide terminals', () => {
    setColumns(300);
    expect(ruleWidth()).toBe(100);
  });

  it('has a floor on very narrow ones', () => {
    setColumns(10);
    expect(ruleWidth()).toBe(24);
  });

  it('assumes 80 when columns is undefined (piped output)', () => {
    setColumns(undefined);
    expect(ruleWidth()).toBe(78);
  });
});

describe('divider', () => {
  it('matches ruleWidth rather than a fixed 48', () => {
    setColumns(120);
    expect(visibleLength(divider())).toBe(ruleWidth());
    expect(visibleLength(divider())).not.toBe(48);
  });
});

describe('box', () => {
  it('sizes to the longest line', () => {
    const lines = box(['short', 'a much longer line']).split('\n');
    const widths = lines.map(visibleLength);
    expect(new Set(widths).size).toBe(1);
  });

  // .length counts escape sequences; visibleLength does not. A colored line
  // used to push the border far past the text.
  it('measures visible width, ignoring colour escapes', () => {
    const plain = box(['abcdefghij']).split('\n').map(visibleLength);
    const colored = box([chalk.red('abcdefghij')]).split('\n').map(visibleLength);
    expect(colored).toEqual(plain);
  });

  it('keeps every line the same visible width with mixed colour', () => {
    const widths = box([chalk.green('yes'), 'a longer plain line'])
      .split('\n')
      .map(visibleLength);
    expect(new Set(widths).size).toBe(1);
  });

  it('handles a single empty line without throwing', () => {
    expect(() => box([''])).not.toThrow();
  });
});
