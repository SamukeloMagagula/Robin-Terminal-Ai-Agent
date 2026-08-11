import { describe, it, expect } from 'vitest';
import { isAbortError } from '../../src/providers/chat-error';

describe('isAbortError', () => {
  it('recognises the DOMException fetch throws on abort', () => {
    const err = new DOMException('This operation was aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('recognises a plain Error named AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('does not mistake an ordinary failure for an abort', () => {
    expect(isAbortError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('aborted')).toBe(false);
  });
});
