import { describe, it, expect } from 'vitest';
import { addToInputHistory, MAX_INPUT_HISTORY } from '../../src/repl/input-history';

describe('addToInputHistory', () => {
  it('appends a line', () => {
    expect(addToInputHistory([], 'hello')).toEqual(['hello']);
    expect(addToInputHistory(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('ignores empty and whitespace-only lines', () => {
    expect(addToInputHistory(['a'], '')).toEqual(['a']);
    expect(addToInputHistory(['a'], '   ')).toEqual(['a']);
    expect(addToInputHistory(['a'], '\t\n')).toEqual(['a']);
  });

  it('collapses a consecutive duplicate', () => {
    expect(addToInputHistory(['/random'], '/random')).toEqual(['/random']);
  });

  it('keeps a repeat that is not consecutive', () => {
    expect(addToInputHistory(['/random', 'hello'], '/random')).toEqual([
      '/random',
      'hello',
      '/random',
    ]);
  });

  it('does not mutate the array it is given', () => {
    const original = ['a'];
    const result = addToInputHistory(original, 'b');
    expect(original).toEqual(['a']);
    expect(result).not.toBe(original);
  });

  it('caps at MAX_INPUT_HISTORY, dropping the oldest first', () => {
    let history: string[] = [];
    for (let i = 0; i < MAX_INPUT_HISTORY + 10; i++) {
      history = addToInputHistory(history, `line-${i}`);
    }
    expect(history).toHaveLength(MAX_INPUT_HISTORY);
    expect(history[0]).toBe('line-10');
    expect(history[history.length - 1]).toBe(`line-${MAX_INPUT_HISTORY + 9}`);
  });
});
