import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkPath,
  isSensitiveBasename,
  isInsideDirectory,
  realPathOrNearest,
  defaultSensitiveDirs,
} from '../../src/tools/sensitive-paths';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-sens-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('isSensitiveBasename', () => {
  it.each(['.env', '.npmrc', '.git-credentials', 'id_rsa', 'credentials', '.netrc'])(
    'flags %s wherever it lives',
    (name) => {
      expect(isSensitiveBasename(path.join('/anywhere/at/all', name))).toBe(true);
    }
  );

  it('is case-insensitive', () => {
    expect(isSensitiveBasename('/x/.ENV')).toBe(true);
  });

  it('leaves ordinary files alone', () => {
    expect(isSensitiveBasename('/x/notes.md')).toBe(false);
    expect(isSensitiveBasename('/x/environment.ts')).toBe(false);
  });
});

describe('defaultSensitiveDirs', () => {
  it('covers the usual credential homes beyond .robin and .ssh', () => {
    const dirs = defaultSensitiveDirs();
    const home = os.homedir();
    for (const expected of ['.ssh', '.aws', '.gnupg', '.kube', '.docker']) {
      expect(dirs).toContain(path.join(home, expected));
    }
  });
});

describe('isInsideDirectory', () => {
  it('rejects lexical traversal', () => {
    expect(isInsideDirectory(path.join(tmp, '..', 'x'), tmp)).toBe(false);
  });

  it('accepts the directory itself and its children', () => {
    expect(isInsideDirectory(tmp, tmp)).toBe(true);
    expect(isInsideDirectory(path.join(tmp, 'a', 'b'), tmp)).toBe(true);
  });
});

describe('realPathOrNearest', () => {
  it('returns the resolved path for a file that exists', async () => {
    const file = path.join(tmp, 'real.txt');
    await fs.writeFile(file, 'x');
    expect(await realPathOrNearest(file)).toBe(await fs.realpath(file));
  });

  it('resolves through a not-yet-existing tail', async () => {
    const target = path.join(tmp, 'sub', 'deep', 'new.txt');
    const resolved = await realPathOrNearest(target);
    expect(resolved.endsWith(path.join('sub', 'deep', 'new.txt'))).toBe(true);
    expect(resolved).toContain(await fs.realpath(tmp));
  });
});

describe('checkPath', () => {
  it('blocks a sensitive directory with verb-appropriate wording', async () => {
    const secret = path.join(tmp, 'vault', 'thing.txt');
    const read = await checkPath(secret, 'read', [path.join(tmp, 'vault')]);
    const write = await checkPath(secret, 'write', [path.join(tmp, 'vault')]);
    expect(read.blocked).toBe(true);
    expect(read.refusal).toBe('refused to read from a protected credential directory');
    expect(write.refusal).toBe('refused to write inside a protected credential directory');
  });

  it('blocks a sensitive basename anywhere', async () => {
    const verdict = await checkPath(path.join(tmp, '.env'), 'read', []);
    expect(verdict.blocked).toBe(true);
    expect(verdict.refusal).toContain('.env');
  });

  it('allows an ordinary file', async () => {
    const verdict = await checkPath(path.join(tmp, 'notes.md'), 'read', []);
    expect(verdict.blocked).toBe(false);
  });

  // The whole point of resolving symlinks: path.resolve() alone would see an
  // innocent path here and wave it through.
  it('blocks a symlink pointing into a protected directory', async () => {
    const vault = path.join(tmp, 'vault');
    await fs.mkdir(vault);
    const secret = path.join(vault, 'auth.json');
    await fs.writeFile(secret, '{}');

    const link = path.join(tmp, 'innocent.txt');
    try {
      await fs.symlink(secret, link);
    } catch {
      return; // Windows without developer mode cannot create symlinks.
    }

    const verdict = await checkPath(link, 'read', [vault]);
    expect(verdict.blocked).toBe(true);
  });
});
