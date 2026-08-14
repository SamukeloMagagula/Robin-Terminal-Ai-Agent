import { describe, it, expect } from 'vitest';
import { createAnswerUnwrapper } from '../src/answer-wrapper';

/** Feeds text through the unwrapper one chunk at a time, as a stream would. */
function stream(chunks: string[]): string {
  const unwrap = createAnswerUnwrapper();
  return chunks.map((chunk) => unwrap.push(chunk)).join('') + unwrap.end();
}

describe('createAnswerUnwrapper', () => {
  it('leaves an ordinary reply alone', () => {
    expect(stream(['Hello ', 'there'])).toBe('Hello there');
  });

  it('passes text through as it arrives rather than holding it to the end', () => {
    const unwrap = createAnswerUnwrapper();
    // A reply that cannot be a wrapper is emitted immediately — anything else
    // would turn streaming into a long pause and a wall of text.
    expect(unwrap.push('Hello')).toBe('Hello');
  });

  it('removes a wrapper that encloses the whole reply', () => {
    expect(stream(['<final_answer>\npong\n</final_answer>'])).toBe('pong');
  });

  it('removes a wrapper that arrives split across chunks', () => {
    expect(stream(['<final', '_answer>', '\npo', 'ng\n</final', '_answer>'])).toBe('pong');
  });

  it('removes a wrapper split at the worst possible places', () => {
    expect(stream(['<', 'f', 'inal_answer', '>', 'x', '<', '/final_answer', '>'])).toBe('x');
  });

  it('tolerates leading whitespace before the wrapper', () => {
    expect(stream(['\n  <final_answer>ok</final_answer>'])).toBe('ok');
  });

  it('handles an unclosed wrapper, because a stream can be cut off', () => {
    expect(stream(['<final_answer>\nhalf an ans'])).toBe('half an ans');
  });

  it('keeps an empty wrapped reply empty rather than inventing text', () => {
    expect(stream(['<final_answer></final_answer>'])).toBe('');
  });

  // The whole point of only stripping a wrapper that starts the reply: a model
  // explaining the tag must not have its explanation mangled.
  it('leaves the tag alone when it is part of the answer rather than around it', () => {
    const text = 'Some models wrap replies in <final_answer> tags, like this.';
    expect(stream([text])).toBe(text);
  });

  it('leaves a closing tag alone when nothing opened it', () => {
    expect(stream(['just text </final_answer> more text'])).toBe(
      'just text </final_answer> more text'
    );
  });

  it('does not strip a tag it does not know', () => {
    expect(stream(['<thinking>hmm</thinking>'])).toBe('<thinking>hmm</thinking>');
  });

  it('keeps text that follows the closing tag, rather than swallowing it', () => {
    // If a model closes the wrapper and keeps talking, that text is still the
    // answer and dropping it would lose content.
    expect(stream(['<final_answer>a</final_answer> and more'])).toBe('a and more');
  });

  it('handles an empty stream', () => {
    expect(stream([])).toBe('');
  });

  it('handles empty chunks', () => {
    expect(stream(['', '<final_answer>', '', 'x', '', '</final_answer>', ''])).toBe('x');
  });
});
