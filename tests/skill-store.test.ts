import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillStore, isValidSkillName, type SavedSkill } from '../src/skill-store';

describe('isValidSkillName', () => {
  it('accepts letters, numbers, dots, dashes, underscores', () => {
    expect(isValidSkillName('terse-reviewer_v2.1')).toBe(true);
  });

  it('rejects path separators', () => {
    expect(isValidSkillName('../secrets')).toBe(false);
    expect(isValidSkillName('a/b')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSkillName('')).toBe(false);
  });
});

describe('SkillStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-store-test-'));
  });

  function sample(): SavedSkill {
    return { prompt: 'You are a terse code reviewer.', savedAt: '2026-08-06T00:00:00.000Z' };
  }

  it('returns an empty list when nothing is saved', async () => {
    const store = new SkillStore(dir);
    expect(await store.list()).toEqual([]);
  });

  it('round-trips a skill through save/load', async () => {
    const store = new SkillStore(dir);
    await store.save('reviewer', sample());
    expect(await store.load('reviewer')).toEqual(sample());
  });

  it('lists saved skill names, sorted', async () => {
    const store = new SkillStore(dir);
    await store.save('b-skill', sample());
    await store.save('a-skill', sample());
    expect(await store.list()).toEqual(['a-skill', 'b-skill']);
  });

  it('rejects an invalid name on save', async () => {
    const store = new SkillStore(dir);
    await expect(store.save('../escape', sample())).rejects.toThrow(/Invalid skill name/);
  });

  it('rejects an invalid name on load', async () => {
    const store = new SkillStore(dir);
    await expect(store.load('../escape')).rejects.toThrow(/Invalid skill name/);
  });

  it('throws when loading a name that was never saved', async () => {
    const store = new SkillStore(dir);
    await expect(store.load('missing')).rejects.toThrow();
  });
});
