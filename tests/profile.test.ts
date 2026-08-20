import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { robinHome, isValidProfileName } from '../src/profile';

describe('isValidProfileName', () => {
  it.each(['work', 'personal-2', 'client.acme', 'a_b'])('accepts %s', (name) => {
    expect(isValidProfileName(name)).toBe(true);
  });

  it.each(['.', '..', '../escape', 'a/b', 'a\\b', ''])('rejects %s', (name) => {
    expect(isValidProfileName(name)).toBe(false);
  });
});

describe('robinHome', () => {
  const original = process.env.ROBIN_PROFILE;

  afterEach(() => {
    if (original === undefined) delete process.env.ROBIN_PROFILE;
    else process.env.ROBIN_PROFILE = original;
  });

  it('defaults to ~/.robin when no profile is set', () => {
    delete process.env.ROBIN_PROFILE;
    expect(robinHome()).toBe(path.join(os.homedir(), '.robin'));
  });

  it('defaults to ~/.robin when the profile is blank', () => {
    process.env.ROBIN_PROFILE = '   ';
    expect(robinHome()).toBe(path.join(os.homedir(), '.robin'));
  });

  it('resolves a named profile under ~/.robin-profiles', () => {
    process.env.ROBIN_PROFILE = 'work';
    expect(robinHome()).toBe(path.join(os.homedir(), '.robin-profiles', 'work'));
  });

  it('rejects a profile name that would escape the profiles directory', () => {
    process.env.ROBIN_PROFILE = '../../etc';
    expect(() => robinHome()).toThrow(/profile/i);
  });

  it('rejects a profile name that is just ".."', () => {
    process.env.ROBIN_PROFILE = '..';
    expect(() => robinHome()).toThrow(/profile/i);
  });
});
