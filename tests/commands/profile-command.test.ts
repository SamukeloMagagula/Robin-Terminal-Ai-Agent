import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { runProfileList } from '../../src/commands/profile-command';

async function tmpProfilesDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'robin-profiles-'));
}

describe('runProfileList', () => {
  it('always lists "default", marked current when ROBIN_PROFILE is unset', async () => {
    const dir = await tmpProfilesDir();
    const lines: string[] = [];
    await runProfileList({ profilesDir: dir, currentProfile: undefined, out: (l) => lines.push(l) });

    const text = lines.join('\n');
    expect(text).toContain('default');
    expect(text).toMatch(/default.*current|current.*default/i);
  });

  it('lists named profiles found under the profiles directory', async () => {
    const dir = await tmpProfilesDir();
    await fs.mkdir(path.join(dir, 'work'));
    await fs.mkdir(path.join(dir, 'personal'));

    const lines: string[] = [];
    await runProfileList({ profilesDir: dir, currentProfile: undefined, out: (l) => lines.push(l) });

    const text = lines.join('\n');
    expect(text).toContain('work');
    expect(text).toContain('personal');
  });

  it('marks the profile named by ROBIN_PROFILE as current, not "default"', async () => {
    const dir = await tmpProfilesDir();
    await fs.mkdir(path.join(dir, 'work'));

    const lines: string[] = [];
    await runProfileList({ profilesDir: dir, currentProfile: 'work', out: (l) => lines.push(l) });

    const text = lines.join('\n');
    const workLine = lines.find((l) => l.includes('work'));
    expect(workLine).toMatch(/current/i);
    const defaultLine = lines.find((l) => l.includes('default'));
    expect(defaultLine).not.toMatch(/current/i);
  });

  it('shows the current named profile even if it has no directory yet (never used)', async () => {
    const dir = await tmpProfilesDir(); // empty — 'work' has no directory
    const lines: string[] = [];
    await runProfileList({ profilesDir: dir, currentProfile: 'work', out: (l) => lines.push(l) });

    const workLine = lines.find((l) => l.includes('work'));
    expect(workLine).toBeDefined();
    expect(workLine).toMatch(/current/i);
  });

  it('does not fail when the profiles directory does not exist yet', async () => {
    const dir = path.join(os.tmpdir(), `robin-profiles-nope-${Date.now()}-${Math.random()}`);
    const lines: string[] = [];
    await expect(
      runProfileList({ profilesDir: dir, currentProfile: undefined, out: (l) => lines.push(l) })
    ).resolves.not.toThrow();
    expect(lines.join('\n')).toContain('default');
  });
});
