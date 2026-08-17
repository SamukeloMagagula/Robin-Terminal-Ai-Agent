import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { renderInline, renderLine, createMarkdownStream } from '../../src/ui/markdown';

/** What the user actually sees: styling removed, text kept. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function streamed(chunks: string[]): string {
  let out = '';
  const stream = createMarkdownStream((text) => {
    out += text;
  });
  for (const chunk of chunks) stream.push(chunk);
  stream.end();
  return out;
}

describe('renderInline', () => {
  // The whole point: markup should style the text, not appear beside it.
  it.each([
    ['**bold**', 'bold'],
    ['__bold__', 'bold'],
    ['*italic*', 'italic'],
    ['_italic_', 'italic'],
    ['~~gone~~', 'gone'],
    ['`code`', 'code'],
  ])('renders %s without showing the markers', (input, expected) => {
    expect(plain(renderInline(input))).toBe(expected);
  });

  it('keeps the surrounding sentence intact', () => {
    expect(plain(renderInline('a **bold** word'))).toBe('a bold word');
  });

  it('handles several spans in one line', () => {
    expect(plain(renderInline('**one** and *two* and `three`'))).toBe('one and two and three');
  });

  // A model writing about code should not have its identifiers mangled.
  it('leaves snake_case alone', () => {
    expect(plain(renderInline('call read_file and write_file now'))).toBe(
      'call read_file and write_file now'
    );
  });

  it('leaves arithmetic alone', () => {
    expect(plain(renderInline('2 * 3 * 4 = 24'))).toBe('2 * 3 * 4 = 24');
  });

  it('leaves a lone asterisk alone', () => {
    expect(plain(renderInline('a * b'))).toBe('a * b');
  });

  // Styling inside a code span would be styling someone's source.
  it('does not style markup inside inline code', () => {
    expect(plain(renderInline('`a **b** c`'))).toBe('a **b** c');
  });

  it('shows a link as its text, with the target after it', () => {
    const rendered = plain(renderInline('see [the docs](https://example.com)'));
    expect(rendered).toContain('the docs');
    expect(rendered).toContain('https://example.com');
    expect(rendered).not.toContain('](');
  });

  // chalk turns itself off when stdout is not a terminal, which is exactly
  // what a test runner is — so colour has to be asked for to be observed.
  it('adds colour when the terminal takes it', () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const rendered = renderInline('**bold**');
      expect(rendered).not.toBe('bold');
      expect(rendered).toContain('bold');
    } finally {
      chalk.level = level;
    }
  });

  it('adds none when it does not', () => {
    const level = chalk.level;
    chalk.level = 0;
    try {
      // NO_COLOR, a pipe, a dumb terminal: the markers still go, the text stays.
      expect(renderInline('**bold** and `code`')).toBe('bold and code');
    } finally {
      chalk.level = level;
    }
  });
});

describe('renderLine', () => {
  it('renders a heading without its hashes', () => {
    expect(plain(renderLine('## A heading'))).toContain('A heading');
    expect(plain(renderLine('## A heading'))).not.toContain('#');
  });

  it.each(['- one', '* one', '+ one'])('renders %s as a bullet', (input) => {
    const rendered = plain(renderLine(input));
    expect(rendered).toContain('one');
    expect(rendered).not.toMatch(/^[-*+]/);
    expect(rendered).toContain('•');
  });

  it('keeps a numbered list numbered', () => {
    expect(plain(renderLine('1. first'))).toContain('1.');
    expect(plain(renderLine('1. first'))).toContain('first');
  });

  it('keeps the indentation of a nested list', () => {
    expect(plain(renderLine('  - nested'))).toMatch(/^\s\s/);
  });

  it('renders a quote with a bar instead of an angle bracket', () => {
    const rendered = plain(renderLine('> quoted'));
    expect(rendered).toContain('quoted');
    expect(rendered).not.toContain('>');
  });

  it('renders a rule as a line', () => {
    expect(plain(renderLine('---'))).toMatch(/^─+$/);
  });

  it('leaves ordinary prose alone', () => {
    expect(plain(renderLine('just a sentence.'))).toBe('just a sentence.');
  });
});

describe('createMarkdownStream', () => {
  it('renders markup that arrives split across chunks', () => {
    expect(plain(streamed(['a **bo', 'ld** word\n']))).toBe('a bold word\n');
  });

  it('emits nothing until a line is complete', () => {
    let out = '';
    const stream = createMarkdownStream((text) => {
      out += text;
    });

    stream.push('**partial');

    // Styling cannot be decided from half a line, and text written raw cannot
    // be taken back.
    expect(out).toBe('');
  });

  it('flushes an unterminated final line', () => {
    expect(plain(streamed(['no trailing newline']))).toBe('no trailing newline');
  });

  it('renders several lines in one chunk', () => {
    expect(plain(streamed(['# Title\n\nbody **here**\n']))).toContain('Title');
    expect(plain(streamed(['# Title\n\nbody **here**\n']))).toContain('body here');
  });

  // Inside a fence the text is someone's source: it must survive byte for byte.
  it('leaves code inside a fence exactly as written', () => {
    const out = plain(streamed(['```js\n', 'const a = **not bold**;\n', '```\n']));
    expect(out).toContain('const a = **not bold**;');
  });

  it('does not show the fence markers themselves', () => {
    const out = plain(streamed(['```\n', 'code\n', '```\n']));
    expect(out).not.toContain('```');
    expect(out).toContain('code');
  });

  it('resumes normal rendering after a fence closes', () => {
    const out = plain(streamed(['```\n', 'raw **x**\n', '```\n', 'after **y**\n']));
    expect(out).toContain('raw **x**');
    expect(out).toContain('after y');
  });

  it('flushes an unclosed fence rather than swallowing it', () => {
    const out = plain(streamed(['```\n', 'still here\n']));
    expect(out).toContain('still here');
  });
});
