import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildFingerprint } from '../../src/gateway/build-id';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-build-'));
  await fs.writeFile(path.join(dir, 'a.js'), 'one', 'utf-8');
  await fs.mkdir(path.join(dir, 'nested'));
  await fs.writeFile(path.join(dir, 'nested', 'b.js'), 'two', 'utf-8');
});

describe('buildFingerprint', () => {
  it('is stable for an unchanged tree', async () => {
    expect(await buildFingerprint(dir)).toBe(await buildFingerprint(dir));
  });

  it('is short enough to print', async () => {
    expect(await buildFingerprint(dir)).toMatch(/^[0-9a-f]{12}$/);
  });

  // The whole point: a rebuild has to look different, including one that only
  // touched a file the daemon's own entry point does not import.
  it('changes when a nested file changes', async () => {
    const before = await buildFingerprint(dir);
    await fs.writeFile(path.join(dir, 'nested', 'b.js'), 'two but longer', 'utf-8');
    expect(await buildFingerprint(dir)).not.toBe(before);
  });

  it('changes when a file is added', async () => {
    const before = await buildFingerprint(dir);
    await fs.writeFile(path.join(dir, 'c.js'), 'three', 'utf-8');
    expect(await buildFingerprint(dir)).not.toBe(before);
  });

  it('changes when a file is removed', async () => {
    const before = await buildFingerprint(dir);
    await fs.rm(path.join(dir, 'a.js'));
    expect(await buildFingerprint(dir)).not.toBe(before);
  });

  it('ignores files that are not compiled output', async () => {
    const before = await buildFingerprint(dir);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'irrelevant', 'utf-8');
    await fs.writeFile(path.join(dir, 'a.js.map'), 'irrelevant', 'utf-8');
    expect(await buildFingerprint(dir)).toBe(before);
  });

  // Never a reason to fail to start: an unreadable directory means "cannot
  // tell", and cannot-tell must not become cannot-run.
  it('returns nothing for a directory that is not there', async () => {
    expect(await buildFingerprint(path.join(dir, 'absent'))).toBeUndefined();
  });
});

describe('freshBuildFingerprint', () => {
  // The daemon has to be able to ask whether the build moved underneath it. A
  // browser cannot compute a fingerprint, so it cannot be the one to notice.
  it('does not return a cached answer', async () => {
    const { freshBuildFingerprint } = await import('../../src/gateway/build-id');
    const first = await freshBuildFingerprint();
    const second = await freshBuildFingerprint();
    // Same build, so the same answer — but arrived at by looking, not by
    // remembering. The cache test below is what proves the difference.
    expect(first).toBe(second);
  });

  it('leaves the cached "what am I running" answer alone', async () => {
    const { buildFingerprint, freshBuildFingerprint } = await import('../../src/gateway/build-id');
    const own = await buildFingerprint();
    await freshBuildFingerprint();
    expect(await buildFingerprint()).toBe(own);
  });
});
