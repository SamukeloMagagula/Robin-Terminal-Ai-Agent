import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeTool } from '../../src/tools/execute';

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-edit-')));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

function edit(args: Record<string, unknown>) {
  return { id: '1', name: 'edit_file', arguments: JSON.stringify(args) };
}

const allow = async (): Promise<boolean> => true;

describe('edit_file', () => {
  it('replaces a unique occurrence and leaves the rest alone', async () => {
    const file = await write('a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const result = await executeTool(
      edit({ path: file, old_string: 'const b = 2;', new_string: 'const b = 22;' }),
      allow
    );

    expect(result).toMatch(/Edited/);
    expect(await fs.readFile(file, 'utf-8')).toBe('const a = 1;\nconst b = 22;\nconst c = 3;\n');
  });

  // The whole reason a targeted edit is safe: an ambiguous match must not pick
  // one at random, because the model cannot see which one it got.
  it('refuses an ambiguous match and says how many there were', async () => {
    const file = await write('a.ts', 'x();\ny();\nx();\n');

    const result = await executeTool(
      edit({ path: file, old_string: 'x();', new_string: 'z();' }),
      allow
    );

    expect(result).toMatch(/appears 2 times/i);
    expect(await fs.readFile(file, 'utf-8')).toBe('x();\ny();\nx();\n');
  });

  it('replaces every occurrence when asked to', async () => {
    const file = await write('a.ts', 'x();\ny();\nx();\n');

    const result = await executeTool(
      edit({ path: file, old_string: 'x();', new_string: 'z();', replace_all: true }),
      allow
    );

    expect(result).toMatch(/replaced 2 occurrences/i);
    expect(await fs.readFile(file, 'utf-8')).toBe('z();\ny();\nz();\n');
  });

  it('reports a string that is not there rather than writing anything', async () => {
    const file = await write('a.ts', 'const a = 1;\n');

    const result = await executeTool(
      edit({ path: file, old_string: 'const zzz = 9;', new_string: 'x' }),
      allow
    );

    expect(result).toMatch(/not found|no match/i);
    expect(await fs.readFile(file, 'utf-8')).toBe('const a = 1;\n');
  });

  it('refuses an edit that changes nothing', async () => {
    const file = await write('a.ts', 'same\n');

    const result = await executeTool(
      edit({ path: file, old_string: 'same', new_string: 'same' }),
      allow
    );

    expect(result).toMatch(/identical|the same|unchanged/i);
  });

  it('refuses an empty search string, which would match everywhere', async () => {
    const file = await write('a.ts', 'content\n');

    const result = await executeTool(edit({ path: file, old_string: '', new_string: 'x' }), allow);

    expect(result).toMatch(/empty/i);
    expect(await fs.readFile(file, 'utf-8')).toBe('content\n');
  });

  it('reports a missing file plainly', async () => {
    const result = await executeTool(
      edit({ path: path.join(dir, 'absent.ts'), old_string: 'a', new_string: 'b' }),
      allow
    );

    expect(result).toMatch(/Error/);
  });

  // A skipped approval must leave the file exactly as it was.
  it('asks before writing, and writes nothing when declined', async () => {
    const file = await write('a.ts', 'before\n');
    const confirm = vi.fn().mockResolvedValue(false);

    const result = await executeTool(
      edit({ path: file, old_string: 'before', new_string: 'after' }),
      confirm
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/declined by the user/);
    expect(await fs.readFile(file, 'utf-8')).toBe('before\n');
  });

  it('shows both sides in what it asks about', async () => {
    const file = await write('a.ts', 'before\n');
    const confirm = vi.fn().mockResolvedValue(false);

    await executeTool(edit({ path: file, old_string: 'before', new_string: 'after' }), confirm);

    const asked = (confirm.mock.calls[0][0] as { message: string }).message;
    expect(asked).toContain('before');
    expect(asked).toContain('after');
  });

  it('resolves a relative path against the session directory', async () => {
    await write('a.ts', 'one\n');

    const result = await executeTool(
      edit({ path: 'a.ts', old_string: 'one', new_string: 'two' }),
      allow,
      { cwd: dir }
    );

    expect(result).toMatch(/Edited/);
    expect(await fs.readFile(path.join(dir, 'a.ts'), 'utf-8')).toBe('two\n');
  });

  // Windows files are full of CRLF and models emit LF. Failing to match on
  // that alone would make the tool useless on the machine it runs on.
  it('matches a LF search string against a CRLF file, and keeps the CRLF', async () => {
    const file = await write('a.ts', 'line one\r\nline two\r\nline three\r\n');

    const result = await executeTool(
      edit({ path: file, old_string: 'line one\nline two', new_string: 'line one\nline TWO' }),
      allow
    );

    expect(result).toMatch(/Edited/);
    // The file's own line endings survive: an edit must not rewrite every line
    // of a file it was asked to change two of.
    expect(await fs.readFile(file, 'utf-8')).toBe('line one\r\nline TWO\r\nline three\r\n');
  });

  it('leaves a LF file with LF endings', async () => {
    const file = await write('a.ts', 'one\ntwo\n');

    await executeTool(edit({ path: file, old_string: 'one\ntwo', new_string: 'one\n2' }), allow);

    expect(await fs.readFile(file, 'utf-8')).toBe('one\n2\n');
  });
});
