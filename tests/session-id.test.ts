import { describe, it, expect } from 'vitest';
import { newSessionId } from '../src/session-id';

describe('newSessionId', () => {
  it('formats as YYYYMMDD_HHmm_<6 hex>', () => {
    expect(newSessionId()).toMatch(/^\d{8}_\d{4}_[0-9a-f]{6}$/);
  });

  it('differs between calls', () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });
});
