import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { AutonomyStore } from '../../src/autonomy/grant-store';
import type { Manifest } from '../../src/autonomy/manifest';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-autonomy-'));
  return path.join(dir, 'autonomy.json');
}

const nightly: Manifest = {
  id: 'nightly-backup',
  created: '2026-08-17T09:12:00Z',
  rules: [{ kind: 'run_command', pattern: 'git *' }],
  expires: null,
};

describe('AutonomyStore', () => {
  it('grants nothing by default', async () => {
    const store = new AutonomyStore(await tempFile());
    expect(await store.get('nightly-backup')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('round-trips a manifest', async () => {
    const store = new AutonomyStore(await tempFile());
    await store.put(nightly);
    expect(await store.get('nightly-backup')).toEqual(nightly);
  });

  it('round-trips an escalation', async () => {
    const store = new AutonomyStore(await tempFile());
    const escalating: Manifest = {
      ...nightly,
      escalate: { surface: 'telegram', windowMinutes: 240 },
    };
    await store.put(escalating);
    expect((await store.get('nightly-backup'))?.escalate).toEqual({
      surface: 'telegram',
      windowMinutes: 240,
    });
  });

  it('grants nothing when the file is corrupt', async () => {
    const file = await tempFile();
    await fs.writeFile(file, '{ not json');
    const store = new AutonomyStore(file);
    expect(await store.get('nightly-backup')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('grants nothing when the version is unrecognised', async () => {
    const file = await tempFile();
    await fs.writeFile(file, JSON.stringify({ version: 99, manifests: { x: nightly } }));
    expect(await new AutonomyStore(file).get('x')).toBeUndefined();
  });

  it('grants nothing when the version is absent', async () => {
    const file = await tempFile();
    await fs.writeFile(file, JSON.stringify({ manifests: { x: nightly } }));
    expect(await new AutonomyStore(file).get('x')).toBeUndefined();
  });

  it('drops a manifest whose rules are the wrong shape, keeping the rest', async () => {
    const file = await tempFile();
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        manifests: {
          bad: { created: 'x', rules: [{ kind: 'run_command' }], expires: null },
          good: { created: 'x', rules: [{ kind: 'run_command', pattern: 'git *' }], expires: null },
        },
      })
    );
    const store = new AutonomyStore(file);
    expect(await store.get('bad')).toBeUndefined();
    expect(await store.get('good')).toBeDefined();
  });

  it('adds a rule to an existing manifest', async () => {
    const store = new AutonomyStore(await tempFile());
    await store.put(nightly);

    expect(
      await store.addRule('nightly-backup', { kind: 'run_command', pattern: 'restic *' })
    ).toBe(true);

    expect((await store.get('nightly-backup'))?.rules).toHaveLength(2);
  });

  it('does not add a rule to a manifest that does not exist', async () => {
    const store = new AutonomyStore(await tempFile());
    expect(await store.addRule('nope', { kind: 'run_command', pattern: 'x' })).toBe(false);
  });

  it('does not duplicate an identical rule', async () => {
    const store = new AutonomyStore(await tempFile());
    await store.put(nightly);
    await store.addRule('nightly-backup', { kind: 'run_command', pattern: 'git *' });
    expect((await store.get('nightly-backup'))?.rules).toHaveLength(1);
  });

  it('keeps manifests separate', async () => {
    const store = new AutonomyStore(await tempFile());
    await store.put(nightly);
    await store.put({ ...nightly, id: 'other', rules: [] });

    await store.addRule('other', { kind: 'run_command', pattern: 'restic *' });

    expect((await store.get('nightly-backup'))?.rules).toHaveLength(1);
    expect((await store.get('other'))?.rules).toHaveLength(1);
  });

  it('writes the file 0600', async () => {
    if (process.platform === 'win32') return;
    const file = await tempFile();
    await new AutonomyStore(file).put(nightly);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions on a file that already exists loosely', async () => {
    if (process.platform === 'win32') return;
    const file = await tempFile();
    await fs.writeFile(file, '{}', { mode: 0o644 });
    await fs.chmod(file, 0o644);

    await new AutonomyStore(file).put(nightly);

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('AutonomyStore.remove', () => {
  it('deletes a manifest, so nothing it granted survives', async () => {
    const store = new AutonomyStore(await tempFile());
    await store.put(nightly);
    expect(await store.remove('nightly-backup')).toBe(true);
    expect(await store.get('nightly-backup')).toBeUndefined();
  });

  it('leaves the other manifests alone', async () => {
    const store = new AutonomyStore(await tempFile());
    await store.put(nightly);
    await store.put({ ...nightly, id: 'weekly-audit' });
    await store.remove('nightly-backup');
    expect((await store.list()).map((m) => m.id)).toEqual(['weekly-audit']);
  });

  it('reports false for a manifest that was never there', async () => {
    const store = new AutonomyStore(await tempFile());
    expect(await store.remove('never-existed')).toBe(false);
  });
});
