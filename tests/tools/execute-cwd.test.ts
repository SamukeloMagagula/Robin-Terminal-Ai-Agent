import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeTool } from '../../src/tools/execute';

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-cwd-')));
  await fs.writeFile(path.join(dir, 'marker.txt'), 'found me', 'utf-8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('executeTool with a cwd', () => {
  it('runs a command in the given directory, not the process one', async () => {
    const result = await executeTool(
      {
        id: '1',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'node -e "console.log(process.cwd())"' }),
      },
      async () => true,
      { cwd: dir }
    );
    expect(result).toContain(dir);
    expect(result).not.toContain(process.cwd());
  });

  it('treats a relative read as relative to that directory', async () => {
    const result = await executeTool(
      { id: '2', name: 'read_file', arguments: JSON.stringify({ path: 'marker.txt' }) },
      // A prompt here would mean it thought the file was outside the session.
      async () => false,
      { cwd: dir }
    );
    expect(result).toContain('found me');
  });

  it('writes a relative path into that directory', async () => {
    const result = await executeTool(
      {
        id: '3',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'written.txt', content: 'hello' }),
      },
      async () => true,
      { cwd: dir }
    );
    expect(result).toContain('Wrote');
    expect(await fs.readFile(path.join(dir, 'written.txt'), 'utf-8')).toBe('hello');
  });

  it('still asks before reading outside that directory', async () => {
    const outside = path.join(os.tmpdir(), `robin-outside-${Date.now()}.txt`);
    await fs.writeFile(outside, 'secret', 'utf-8');
    let asked = false;

    const result = await executeTool(
      { id: '4', name: 'read_file', arguments: JSON.stringify({ path: outside }) },
      async () => {
        asked = true;
        return false;
      },
      { cwd: dir }
    );

    expect(asked).toBe(true);
    expect(result).toContain('declined by the user');
    await fs.rm(outside, { force: true });
  });

  it('falls back to the process directory when no cwd is given', async () => {
    const result = await executeTool(
      {
        id: '5',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'node -e "console.log(process.cwd())"' }),
      },
      async () => true,
      {}
    );
    expect(result).toContain(process.cwd());
  });
});
