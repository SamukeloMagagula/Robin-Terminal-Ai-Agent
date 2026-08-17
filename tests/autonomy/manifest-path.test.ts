import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  matchesPath,
  matchesMcpTool,
  permits,
  type Manifest,
} from '../../src/autonomy/manifest';

async function tempDir(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-glob-')));
}

const manifest = (rules: Manifest['rules'], expires: string | null = null): Manifest => ({
  id: 'test',
  created: '2026-08-17T00:00:00Z',
  rules,
  expires,
});

const now = new Date('2026-08-17T12:00:00Z');

describe('matchesPath', () => {
  it('matches a file under a ** root', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a', 'b.txt');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'x');

    expect(await matchesPath(path.join(dir, '**'), file)).toBe(true);
  });

  it('matches a direct child under a ** root', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'top.txt'), 'x');

    expect(await matchesPath(path.join(dir, '**'), path.join(dir, 'top.txt'))).toBe(true);
  });

  it('matches a path that does not exist yet', async () => {
    const dir = await tempDir();

    expect(await matchesPath(path.join(dir, '**'), path.join(dir, 'not-yet.txt'))).toBe(true);
  });

  it('refuses a traversal out of the root', async () => {
    const dir = await tempDir();
    const code = path.join(dir, 'code');
    await fs.mkdir(code, { recursive: true });
    await fs.writeFile(path.join(dir, 'secret'), 'x');

    expect(await matchesPath(path.join(code, '**'), path.join(code, '..', 'secret'))).toBe(false);
  });

  it('refuses a sibling directory with a shared prefix', async () => {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, 'code'), { recursive: true });
    await fs.mkdir(path.join(dir, 'code-secrets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'code-secrets', 'x'), 'x');

    expect(
      await matchesPath(path.join(dir, 'code', '**'), path.join(dir, 'code-secrets', 'x'))
    ).toBe(false);
  });

  it('refuses a symlink that escapes the root', async () => {
    const dir = await tempDir();
    const outside = path.join(dir, 'outside');
    const code = path.join(dir, 'code');
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(code, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret'), 'x');
    try {
      await fs.symlink(path.join(outside, 'secret'), path.join(code, 'link'));
    } catch {
      return; // Windows without developer mode cannot create symlinks.
    }

    expect(await matchesPath(path.join(code, '**'), path.join(code, 'link'))).toBe(false);
  });

  it('matches a single-segment * but not across separators', async () => {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, 'a'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a', 'b.txt'), 'x');

    expect(await matchesPath(path.join(dir, '*'), path.join(dir, 'a'))).toBe(true);
    expect(await matchesPath(path.join(dir, '*'), path.join(dir, 'a', 'b.txt'))).toBe(false);
  });

  it('matches a literal pattern with no wildcard at all', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'exact.txt');
    await fs.writeFile(file, 'x');

    expect(await matchesPath(file, file)).toBe(true);
    expect(await matchesPath(file, path.join(dir, 'other.txt'))).toBe(false);
  });

  it('does not let a pattern smuggle regex syntax', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'axb'), 'x');

    // `.` is a literal dot, not "any character".
    expect(await matchesPath(path.join(dir, 'a.b'), path.join(dir, 'axb'))).toBe(false);
  });
});

describe('matchesMcpTool', () => {
  it('matches a server wildcard', () => {
    expect(matchesMcpTool('github.*', 'github.create_issue')).toBe(true);
  });
  it('matches an exact tool', () => {
    expect(matchesMcpTool('github.create_issue', 'github.create_issue')).toBe(true);
  });
  it('refuses a different server', () => {
    expect(matchesMcpTool('github.*', 'gitlab.create_issue')).toBe(false);
  });
  it('refuses a different tool on the right server', () => {
    expect(matchesMcpTool('github.create_issue', 'github.delete_repo')).toBe(false);
  });
  it('refuses a wildcard server half', () => {
    expect(matchesMcpTool('*.create_issue', 'github.create_issue')).toBe(false);
  });
  it('refuses a bare name with no server', () => {
    expect(matchesMcpTool('github.*', 'create_issue')).toBe(false);
  });
});

describe('permits', () => {
  it('permits a command covered by a rule', async () => {
    const m = manifest([{ kind: 'run_command', pattern: 'git *' }]);
    expect(await permits(m, { kind: 'run_command', message: '', subject: 'git status' }, now)).toBe(
      true
    );
  });

  it('refuses a command no rule covers', async () => {
    const m = manifest([{ kind: 'run_command', pattern: 'git *' }]);
    expect(
      await permits(m, { kind: 'run_command', message: '', subject: 'restic snapshot' }, now)
    ).toBe(false);
  });

  it('refuses when the kinds differ even if the pattern would match', async () => {
    const m = manifest([{ kind: 'read_file', pattern: 'git *' }]);
    expect(await permits(m, { kind: 'run_command', message: '', subject: 'git status' }, now)).toBe(
      false
    );
  });

  it('grants nothing once expired', async () => {
    const m = manifest([{ kind: 'run_command', pattern: 'git *' }], '2026-08-17T06:00:00Z');
    expect(await permits(m, { kind: 'run_command', message: '', subject: 'git status' }, now)).toBe(
      false
    );
  });

  it('still grants before the expiry passes', async () => {
    const m = manifest([{ kind: 'run_command', pattern: 'git *' }], '2026-08-17T18:00:00Z');
    expect(await permits(m, { kind: 'run_command', message: '', subject: 'git status' }, now)).toBe(
      true
    );
  });

  it('grants nothing for an unparseable expiry', async () => {
    const m = manifest([{ kind: 'run_command', pattern: 'git *' }], 'not-a-date');
    expect(await permits(m, { kind: 'run_command', message: '', subject: 'git status' }, now)).toBe(
      false
    );
  });

  it('grants nothing with no rules', async () => {
    expect(
      await permits(manifest([]), { kind: 'run_command', message: '', subject: 'git status' }, now)
    ).toBe(false);
  });

  it('never throws on a malformed rule, and skips only that rule', async () => {
    const m = manifest([
      { kind: 'run_command', pattern: '' },
      { kind: 'run_command', pattern: 'git *' },
    ]);
    expect(await permits(m, { kind: 'run_command', message: '', subject: 'git status' }, now)).toBe(
      true
    );
  });
});
