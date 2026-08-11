import { describe, it, expect } from 'vitest';
import { LineBuffer } from '../../src/repl/line-buffer';

describe('LineBuffer', () => {
  it('starts empty with the cursor at the origin', () => {
    const b = new LineBuffer();
    expect(b.text).toBe('');
    expect(b.lines).toEqual(['']);
    expect(b.cursorLine).toBe(0);
    expect(b.cursorColumn).toBe(0);
  });

  it('inserts characters at the cursor', () => {
    const b = new LineBuffer();
    b.insert('ab');
    b.insert('c');
    expect(b.text).toBe('abc');
    expect(b.cursorColumn).toBe(3);
  });

  it('splits into lines on newline', () => {
    const b = new LineBuffer();
    b.insert('one');
    b.newline();
    b.insert('two');
    expect(b.lines).toEqual(['one', 'two']);
    expect(b.cursorLine).toBe(1);
    expect(b.cursorColumn).toBe(3);
  });

  it('inserts in the middle rather than appending', () => {
    const b = new LineBuffer();
    b.insert('ac');
    b.moveLeft();
    b.insert('b');
    expect(b.text).toBe('abc');
  });

  it('backspace joins two lines when at the start of one', () => {
    const b = new LineBuffer();
    b.insert('one');
    b.newline();
    b.backspace();
    expect(b.lines).toEqual(['one']);
    expect(b.cursorColumn).toBe(3);
  });

  it('moveUp keeps the column where the line is long enough', () => {
    const b = new LineBuffer();
    b.insert('long line');
    b.newline();
    b.insert('also long');
    b.moveUp();
    expect(b.cursorLine).toBe(0);
    expect(b.cursorColumn).toBe(9);
  });

  it('moveUp clamps the column on a shorter line', () => {
    const b = new LineBuffer();
    b.insert('ab');
    b.newline();
    b.insert('long line');
    b.moveUp();
    expect(b.cursorLine).toBe(0);
    expect(b.cursorColumn).toBe(2);
  });

  it('reports whether the cursor is on the first or last line', () => {
    const b = new LineBuffer();
    b.insert('one');
    expect(b.atFirstLine).toBe(true);
    expect(b.atLastLine).toBe(true);

    b.newline();
    b.insert('two');
    expect(b.atFirstLine).toBe(false);
    expect(b.atLastLine).toBe(true);

    b.moveUp();
    expect(b.atFirstLine).toBe(true);
    expect(b.atLastLine).toBe(false);
  });

  it('setText replaces everything and parks the cursor at the end', () => {
    const b = new LineBuffer();
    b.insert('old');
    b.setText('new\ntext');
    expect(b.lines).toEqual(['new', 'text']);
    expect(b.cursorLine).toBe(1);
    expect(b.cursorColumn).toBe(4);
  });

  it('does not move past either end', () => {
    const b = new LineBuffer();
    b.moveLeft();
    b.moveUp();
    expect(b.cursorColumn).toBe(0);
    b.insert('x');
    b.moveRight();
    b.moveDown();
    expect(b.cursorColumn).toBe(1);
  });
});
