import { describe, it, expect } from 'vitest';
import {
  describeChatError,
  extractServerMessage,
  extractErrorCode,
} from '../../src/providers/http-error';

// The exact body GitHub Copilot returned for a model it lists but cannot serve.
const COPILOT_400 = JSON.stringify({
  error: {
    message: 'The requested model is not supported.',
    code: 'model_not_supported',
    param: 'model',
    type: 'invalid_request_error',
  },
});

describe('extractServerMessage', () => {
  it('pulls error.message out of an OpenAI-style body', () => {
    expect(extractServerMessage(COPILOT_400)).toBe('The requested model is not supported.');
  });

  it('falls back to a top-level message', () => {
    expect(extractServerMessage(JSON.stringify({ message: 'quota exhausted' }))).toBe(
      'quota exhausted'
    );
  });

  it('handles error being a plain string', () => {
    expect(extractServerMessage(JSON.stringify({ error: 'something broke' }))).toBe(
      'something broke'
    );
  });

  it('uses short plain text as-is', () => {
    expect(extractServerMessage('model unavailable')).toBe('model unavailable');
  });

  // An HTML error page is noise, not an explanation.
  it('ignores an HTML body', () => {
    expect(extractServerMessage('<html><body>502 Bad Gateway</body></html>')).toBeUndefined();
  });

  it('ignores empty and missing bodies', () => {
    expect(extractServerMessage(undefined)).toBeUndefined();
    expect(extractServerMessage('')).toBeUndefined();
    expect(extractServerMessage('   ')).toBeUndefined();
  });

  it('ignores JSON with no message anywhere', () => {
    expect(extractServerMessage(JSON.stringify({ status: 'failed' }))).toBeUndefined();
  });

  it('collapses whitespace and truncates a very long message', () => {
    const long = 'x'.repeat(500);
    const result = extractServerMessage(JSON.stringify({ error: { message: long } }));
    expect(result).toHaveLength(201);
    expect(result?.endsWith('…')).toBe(true);
  });
});

describe('extractErrorCode', () => {
  it('reads the machine-readable code', () => {
    expect(extractErrorCode(COPILOT_400)).toBe('model_not_supported');
  });

  it('is undefined when absent or unparseable', () => {
    expect(extractErrorCode(JSON.stringify({ error: { message: 'x' } }))).toBeUndefined();
    expect(extractErrorCode('not json')).toBeUndefined();
    expect(extractErrorCode(undefined)).toBeUndefined();
  });
});

describe('describeChatError', () => {
  // The whole point: "400 (request failed)" told the user nothing.
  it('appends the provider’s own explanation', () => {
    expect(describeChatError('Copilot', 400, COPILOT_400)).toBe(
      'Copilot chat request failed: 400 (request failed) — The requested model is not supported.'
    );
  });

  it('keeps the old shape when there is no usable body', () => {
    expect(describeChatError('Copilot', 429)).toBe(
      'Copilot chat request failed: 429 (rate limited)'
    );
    expect(describeChatError('Copilot', 500, '<html>oops</html>')).toBe(
      'Copilot chat request failed: 500 (server error)'
    );
  });
});
