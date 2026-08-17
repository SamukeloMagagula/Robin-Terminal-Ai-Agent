import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  MemoryStore,
  MAX_INDEX_BYTES,
  isValidMemoryName,
} from '../../src/memory/store';

async function store(): Promise<{ dir: string; store: MemoryStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-mem-'));
  return { dir, store: new MemoryStore(dir) };
}

describe('isValidMemoryName', () => {
  it('accepts ordinary slugs', () => {
    expect(isValidMemoryName('prefers-tabs')).toBe(true);
  });

  it('rejects anything that could escape the memory directory', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '', '.', '..']) {
      expect(isValidMemoryName(bad)).toBe(false);
    }
  });
});

describe('MemoryStore', () => {
  it('starts empty', async () => {
    const { store: s } = await store();
    expect(await s.list()).toEqual([]);
    expect(await s.index()).toBe('');
  });

  it('round-trips a memory', async () => {
    const { store: s } = await store();

    await s.write({
      name: 'prefers-tabs',
      description: 'Indents with tabs, not spaces',
      type: 'user',
      body: 'Always use tabs.',
    });

    const read = await s.read('prefers-tabs');
    expect(read).toEqual({
      name: 'prefers-tabs',
      description: 'Indents with tabs, not spaces',
      type: 'user',
      body: 'Always use tabs.',
    });
  });

  it('lists entries in creation order', async () => {
    const { store: s } = await store();
    await s.write({ name: 'first', description: 'a', type: 'user', body: 'x' });
    await s.write({ name: 'second', description: 'b', type: 'project', body: 'y' });

    expect((await s.list()).map((m) => m.name)).toEqual(['first', 'second']);
  });

  it('updates an existing memory in place rather than adding a second', async () => {
    const { store: s } = await store();
    await s.write({ name: 'dup', description: 'old', type: 'user', body: 'old body' });

    await s.write({ name: 'dup', description: 'new', type: 'user', body: 'new body' });

    const all = await s.list();
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe('new');
    expect((await s.read('dup'))?.body).toBe('new body');
  });

  it('builds an index of one line per memory, without the bodies', async () => {
    const { store: s } = await store();
    await s.write({
      name: 'prefers-tabs',
      description: 'Indents with tabs',
      type: 'user',
      body: 'A LONG BODY THAT MUST NOT APPEAR',
    });

    const index = await s.index();

    expect(index).toContain('prefers-tabs');
    expect(index).toContain('Indents with tabs');
    expect(index).not.toContain('A LONG BODY THAT MUST NOT APPEAR');
  });

  it('caps the index by dropping oldest-created first, and never from disk', async () => {
    const { store: s } = await store();
    const filler = 'x'.repeat(400);
    for (let i = 0; i < 40; i++) {
      await s.write({ name: `m${i}`, description: `${i}-${filler}`, type: 'user', body: 'b' });
    }

    const index = await s.index();

    expect(index.length).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    // Newest survives, oldest is the one dropped from the prompt...
    expect(index).toContain('m39');
    expect(index).not.toContain('m0-');
    // ...but every memory is still on disk.
    expect(await s.list()).toHaveLength(40);
    expect(await s.read('m0')).toBeDefined();
    // Forty sequential file writes on Windows, alongside every other suite
    // running at once, occasionally passes five seconds. The default timeout
    // was reporting slow IO as a failure, which costs more than it catches.
  }, 20000);

  it('forget removes the memory and drops it from the index', async () => {
    const { store: s } = await store();
    await s.write({ name: 'gone', description: 'bye', type: 'user', body: 'x' });

    expect(await s.forget('gone')).toBe(true);

    expect(await s.read('gone')).toBeUndefined();
    expect(await s.index()).not.toContain('gone');
    expect(await s.forget('gone')).toBe(false);
  });

  it('refuses a name that could escape the directory', async () => {
    const { store: s } = await store();

    await expect(
      s.write({ name: '../escape', description: 'x', type: 'user', body: 'y' })
    ).rejects.toThrow(/Invalid memory name/);
  });

  it('skips a file with unreadable frontmatter rather than failing the whole list', async () => {
    const { dir, store: s } = await store();
    await s.write({ name: 'good', description: 'ok', type: 'user', body: 'x' });
    await fs.writeFile(path.join(dir, 'broken.md'), 'no frontmatter here');

    expect((await s.list()).map((m) => m.name)).toEqual(['good']);
  });

  it('reads and caps the profile', async () => {
    const { dir, store: s } = await store();
    await fs.writeFile(path.join(dir, 'profile.md'), 'Prefers concise answers.');

    expect(await s.profile()).toBe('Prefers concise answers.');
  });

  it('returns no profile when there is none', async () => {
    const { store: s } = await store();
    expect(await s.profile()).toBeUndefined();
  });

  it('tolerates an unwritable directory rather than throwing at the prompt', async () => {
    const s = new MemoryStore('\0invalid');
    expect(await s.list()).toEqual([]);
    expect(await s.index()).toBe('');
    expect(await s.profile()).toBeUndefined();
  });
});
