import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { discoverPersonality, MAX_PERSONALITY_BYTES } from '../src/personality';
import { createSession, buildSystemPrompt } from '../src/repl/session';
import type { Provider } from '../src/providers/types';

async function tempDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-persona-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(home, '.robin'), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  return { home, project };
}

describe('discoverPersonality', () => {
  it('finds nothing when neither file exists', async () => {
    const { home, project } = await tempDirs();
    expect(await discoverPersonality(project, path.join(home, '.robin'))).toEqual([]);
  });

  it('finds the global file', async () => {
    const { home, project } = await tempDirs();
    await fs.writeFile(path.join(home, '.robin', 'PERSONALITY.md'), 'Be terse.');

    const found = await discoverPersonality(project, path.join(home, '.robin'));

    expect(found).toHaveLength(1);
    expect(found[0].content).toBe('Be terse.');
    expect(found[0].scope).toBe('global');
  });

  it('returns the global file before the project file', async () => {
    const { home, project } = await tempDirs();
    await fs.writeFile(path.join(home, '.robin', 'PERSONALITY.md'), 'Be terse.');
    await fs.writeFile(path.join(project, 'PERSONALITY.md'), 'Be verbose.');

    const found = await discoverPersonality(project, path.join(home, '.robin'));

    expect(found.map((p) => p.scope)).toEqual(['global', 'project']);
  });

  it('skips a file larger than the cap rather than sending it', async () => {
    const { home, project } = await tempDirs();
    await fs.writeFile(path.join(project, 'PERSONALITY.md'), 'x'.repeat(MAX_PERSONALITY_BYTES + 1));

    expect(await discoverPersonality(project, path.join(home, '.robin'))).toEqual([]);
  });

  it('does not look in parent directories', async () => {
    const { home, project } = await tempDirs();
    await fs.writeFile(path.join(project, 'PERSONALITY.md'), 'parent');
    const child = path.join(project, 'child');
    await fs.mkdir(child);

    expect(await discoverPersonality(child, path.join(home, '.robin'))).toEqual([]);
  });
});

describe('discoverPersonality — profile awareness', () => {
  const original = process.env.ROBIN_PROFILE;

  afterEach(() => {
    if (original === undefined) delete process.env.ROBIN_PROFILE;
    else process.env.ROBIN_PROFILE = original;
  });

  it('defaults its global lookup to robinHome(), not the bare OS home directory', async () => {
    const { robinHome } = await import('../src/profile');
    process.env.ROBIN_PROFILE = `discoverpersonality-test-${Date.now()}`;
    const dir = robinHome();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'PERSONALITY.md'), 'Under the profile.');

    try {
      const found = await discoverPersonality(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-persona-proj-')));
      expect(found.some((p) => p.content === 'Under the profile.')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildSystemPrompt with a personality', () => {
  function session() {
    return createSession({ id: 'x', name: 'X' } as unknown as Provider, 'm');
  }

  it('places personality after the environment and before the system prompt', () => {
    const s = session();
    s.personality = 'Be terse.';
    s.systemPrompt = 'Answer only in haiku.';

    const prompt = buildSystemPrompt(s);

    expect(prompt.indexOf('Working directory:')).toBeLessThan(prompt.indexOf('Be terse.'));
    expect(prompt.indexOf('Be terse.')).toBeLessThan(prompt.indexOf('Answer only in haiku.'));
  });

  it('omits the personality section entirely when none is set', () => {
    expect(buildSystemPrompt(session())).not.toContain('undefined');
  });
});
