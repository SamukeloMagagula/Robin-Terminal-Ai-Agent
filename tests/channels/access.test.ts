import { describe, it, expect } from 'vitest';
import { checkAccess, parseAllowlist, normalizeId } from '../../src/channels/access';

describe('parseAllowlist', () => {
  it('accepts strings', () => {
    expect(parseAllowlist(['123', '456'])).toEqual(['123', '456']);
  });

  it('accepts numbers, because Telegram ids are numeric in JSON', () => {
    expect(parseAllowlist([123, 456])).toEqual(['123', '456']);
  });

  it('trims surrounding whitespace', () => {
    expect(parseAllowlist([' 123 '])).toEqual(['123']);
  });

  it('drops entries that are neither string nor number', () => {
    expect(parseAllowlist(['123', null, {}, [], true])).toEqual(['123']);
  });

  it('drops entries that are empty once trimmed', () => {
    expect(parseAllowlist(['', '   ', '7'])).toEqual(['7']);
  });

  it('returns empty for a non-array, so a malformed config authorises nobody', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('123')).toEqual([]);
    expect(parseAllowlist({ 0: '123' })).toEqual([]);
  });
});

describe('checkAccess', () => {
  it('allows a sender on the list', () => {
    expect(checkAccess('123', ['123', '456']).allowed).toBe(true);
  });

  it('allows a sender whose id arrives with whitespace', () => {
    expect(checkAccess(' 123 ', ['123']).allowed).toBe(true);
  });

  it('refuses a sender not on the list', () => {
    const decision = checkAccess('999', ['123']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('999');
  });

  it('refuses everyone when the allowlist is empty — fails closed', () => {
    const decision = checkAccess('123', []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('empty');
  });

  it('does not match on a prefix or substring of an allowed id', () => {
    expect(checkAccess('12', ['123']).allowed).toBe(false);
    expect(checkAccess('1234', ['123']).allowed).toBe(false);
  });
});

describe('normalizeId', () => {
  it('trims without altering the id otherwise', () => {
    expect(normalizeId('  +27 82 000  ')).toBe('+27 82 000');
  });
});
