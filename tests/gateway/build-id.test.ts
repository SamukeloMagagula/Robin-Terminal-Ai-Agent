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
