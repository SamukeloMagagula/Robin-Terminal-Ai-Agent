import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SkillStore, SKILL_FILE } from '../../src/skills/store';

async function store(): Promise<{ dir: string; store: SkillStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-skills-'));
  return { dir, store: new SkillStore(dir) };
}

/** A preset in the format Robin used before skills became markdown. */
async function writeLegacy(dir: string, name: string, prompt: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, `${name}.json`),
    JSON.stringify({ prompt, savedAt: new Date().toISOString() })
  );
}

describe('SkillStore', () => {
  it('starts empty', async () => {
    const { store: s } = await store();
    expect(await s.list()).toEqual([]);
    expect(await s.index()).toBe('');
  });

  it('round-trips a markdown skill', async () => {
    const { store: s } = await store();

    await s.write({ name: 'reviewer', description: 'Reviews code', body: 'Be strict.' });

    expect(await s.read('reviewer')).toEqual({
      name: 'reviewer',
      description: 'Reviews code',
      body: 'Be strict.',
    });
  });

  it('writes the agentskills.io layout: <name>/SKILL.md', async () => {
    const { dir, store: s } = await store();

    await s.write({ name: 'reviewer', description: 'd', body: 'b' });

    // The layout is what makes a skill portable to and from other tools.
    await expect(fs.access(path.join(dir, 'reviewer', SKILL_FILE))).resolves.toBeUndefined();
  });

  it('still reads a legacy JSON preset', async () => {
    const { dir, store: s } = await store();
    await writeLegacy(dir, 'old', 'Answer only in haiku.');

    const skill = await s.read('old');

    expect(skill?.body).toBe('Answer only in haiku.');
    expect((await s.list()).map((x) => x.name)).toEqual(['old']);
  });

  it('prefers markdown when both formats exist for one name', async () => {
    const { dir, store: s } = await store();
    await writeLegacy(dir, 'both', 'legacy text');
    await s.write({ name: 'both', description: 'd', body: 'markdown text' });

    expect((await s.read('both'))?.body).toBe('markdown text');
    // ...and it appears once, not twice.
    expect((await s.list()).filter((x) => x.name === 'both')).toHaveLength(1);
  });

  it('migrate converts legacy presets and leaves the originals in place', async () => {
    const { dir, store: s } = await store();
    await writeLegacy(dir, 'old', 'Answer only in haiku.');

    expect(await s.migrate()).toEqual(['old']);

    await expect(fs.access(path.join(dir, 'old', SKILL_FILE))).resolves.toBeUndefined();
    // The original is kept: a conversion the user did not ask for must not be
    // able to lose the only copy of something they wrote.
    await expect(fs.access(path.join(dir, 'old.json'))).resolves.toBeUndefined();
    expect((await s.read('old'))?.body).toBe('Answer only in haiku.');
  });

  it('migrate is idempotent and does not overwrite an edited conversion', async () => {
    const { dir, store: s } = await store();
    await writeLegacy(dir, 'old', 'original');
    await s.migrate();
    await s.write({ name: 'old', description: 'edited', body: 'edited by hand' });

    expect(await s.migrate()).toEqual([]);
    expect((await s.read('old'))?.body).toBe('edited by hand');
  });

  it('builds an index of descriptions without the bodies', async () => {
    const { store: s } = await store();
    await s.write({
      name: 'reviewer',
      description: 'Reviews code strictly',
      body: 'A LONG INSTRUCTION SET THAT MUST NOT BE SENT',
    });

    const index = await s.index();

    expect(index).toContain('Reviews code strictly');
    expect(index).not.toContain('A LONG INSTRUCTION SET THAT MUST NOT BE SENT');
  });

  it('forget removes a markdown skill', async () => {
    const { store: s } = await store();
    await s.write({ name: 'gone', description: 'd', body: 'b' });

    expect(await s.forget('gone')).toBe(true);
    expect(await s.read('gone')).toBeUndefined();
    expect(await s.forget('gone')).toBe(false);
  });

  it('refuses a name that could escape the skills directory', async () => {
    const { store: s } = await store();

    await expect(s.write({ name: '../escape', description: 'd', body: 'b' })).rejects.toThrow(
      /Invalid skill name/
    );
    expect(await s.read('../escape')).toBeUndefined();
  });

  it('skips a SKILL.md with no frontmatter rather than failing the list', async () => {
    const { dir, store: s } = await store();
    await s.write({ name: 'good', description: 'd', body: 'b' });
    await fs.mkdir(path.join(dir, 'broken'));
    await fs.writeFile(path.join(dir, 'broken', SKILL_FILE), 'no frontmatter');

    expect((await s.list()).map((x) => x.name)).toEqual(['good']);
  });

  it('tolerates a missing skills directory', async () => {
    const s = new SkillStore(path.join(os.tmpdir(), 'robin-skills-absent'));
    expect(await s.list()).toEqual([]);
    expect(await s.migrate()).toEqual([]);
  });
});
