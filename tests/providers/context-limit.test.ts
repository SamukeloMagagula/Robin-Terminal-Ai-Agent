import { describe, it, expect } from 'vitest';
import { ChatRequestError } from '../../src/providers/chat-error';
import { isContextOverflow, parseContextLimit } from '../../src/providers/context-limit';
import { isModelUnsupported } from '../../src/providers/chat-error';

function serverError(message: string, status = 400): ChatRequestError {
  return new ChatRequestError(`${status} — ${message}`, { status, serverMessage: message });
}

// The exact wording each provider was seen to use.
const COPILOT = 'prompt token count of 12660 exceeds the limit of 12288';
const OPENAI =
  "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens";
const ANTHROPIC = 'prompt is too long: 250000 tokens > 200000 maximum';
const GEMINI =
  'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)';

describe('isContextOverflow', () => {
  it.each([COPILOT, OPENAI, ANTHROPIC, GEMINI])('recognises %s', (message) => {
    expect(isContextOverflow(serverError(message))).toBe(true);
  });

  it('recognises the OpenAI error code', () => {
    expect(
      isContextOverflow(
        new ChatRequestError('400', { status: 400, code: 'context_length_exceeded' })
      )
    ).toBe(true);
  });

  it('is not fooled by an unsupported model or a rate limit', () => {
    expect(isContextOverflow(serverError('The requested model is not supported.'))).toBe(false);
    expect(isContextOverflow(serverError('too many tokens', 429))).toBe(false);
  });

  it('does not overlap with isModelUnsupported', () => {
    // Both run on the same error in run-turn, and an overflow recorded as an
    // unsupported model would hide a working model for good.
    for (const message of [COPILOT, OPENAI, ANTHROPIC, GEMINI]) {
      expect(isModelUnsupported(serverError(message))).toBe(false);
    }
  });
});

describe('parseContextLimit', () => {
  it.each([
    [COPILOT, 12288],
    [OPENAI, 8192],
    [ANTHROPIC, 200000],
    [GEMINI, 1048576],
  ])('reads the limit, not the prompt size, from %s', (message, expected) => {
    expect(parseContextLimit(serverError(message))).toBe(expected);
  });

  it('returns undefined when the provider did not say', () => {
    expect(parseContextLimit(serverError('prompt is too long'))).toBeUndefined();
  });

  it('ignores an implausibly small number', () => {
    expect(parseContextLimit(serverError('maximum context length is 8 tokens'))).toBeUndefined();
  });
});
