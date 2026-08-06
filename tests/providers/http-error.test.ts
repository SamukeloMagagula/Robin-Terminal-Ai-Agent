import { describe, it, expect } from 'vitest';
import { httpErrorDetail, describeChatError } from '../../src/providers/http-error';

describe('httpErrorDetail', () => {
  it('labels 402 as insufficient credits/quota', () => {
    expect(httpErrorDetail(402)).toBe('insufficient credits/quota');
  });

  it('labels 401 and 403 as authentication/authorization failed', () => {
    expect(httpErrorDetail(401)).toBe('authentication/authorization failed');
    expect(httpErrorDetail(403)).toBe('authentication/authorization failed');
  });

  it('labels 429 as rate limited', () => {
    expect(httpErrorDetail(429)).toBe('rate limited');
  });

  it('labels 5xx as server error', () => {
    expect(httpErrorDetail(500)).toBe('server error');
    expect(httpErrorDetail(503)).toBe('server error');
  });

  it('falls back to a generic label for other statuses', () => {
    expect(httpErrorDetail(418)).toBe('request failed');
  });
});

describe('describeChatError', () => {
  it('combines provider label, status, and detail', () => {
    expect(describeChatError('OpenRouter', 402)).toBe('OpenRouter chat request failed: 402 (insufficient credits/quota)');
  });
});
