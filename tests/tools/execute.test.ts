import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeTool, isInsideDirectory } from '../../src/tools/execute';
import { defaultAuthPath } from '../../src/auth-store';
import type { ToolCall } from '../../src/providers/types';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call-1', name, arguments: JSON.stringify(args) };
}

describe('executeTool', () => {
  it('read_file returns file contents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const filePath = path.join(dir, 'a.txt');
    await fs.writeFile(filePath, 'hello world');
    const result = await executeTool(call('read_file', { path: filePath }), async () => true);
    expect(result).toBe('hello world');
  });

  it('read_file returns an error message for a missing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const result = await executeTool(
      call('read_file', { path: path.join(dir, 'missing.txt') }),
      async () => true
    );
    expect(result).toMatch(/^Error:/);
  });

  it('write_file writes the file when confirmed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const filePath = path.join(dir, 'b.txt');
    const result = await executeTool(
      call('write_file', { path: filePath, content: 'hi there' }),
      async () => true
    );
    expect(result).toMatch(/^Wrote \d+ bytes/);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('hi there');
  });

  it('write_file does not write when declined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const filePath = path.join(dir, 'c.txt');
    const result = await executeTool(
      call('write_file', { path: filePath, content: 'nope' }),
      async () => false
    );
    expect(result).toBe(`Write to ${filePath} was declined by the user.`);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('run_command executes and returns output when confirmed', async () => {
    const result = await executeTool(
      call('run_command', { command: 'node -e "console.log(1+1)"' }),
      async () => true
    );
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('2');
  });

  it('run_command does not execute when declined', async () => {
    const result = await executeTool(
      call('run_command', { command: 'node -e "process.exit(1)"' }),
      async () => false
    );
    expect(result).toBe('Command "node -e "process.exit(1)"" was declined by the user.');
  });

  it('returns an error message for an unknown tool name', async () => {
    const result = await executeTool(call('bogus_tool', {}), async () => true);
    expect(result).toMatch(/unknown tool/);
  });

  it('returns an error message for malformed JSON arguments', async () => {
    const toolCall = { id: 'call-1', name: 'read_file', arguments: '{not valid json' };
    const result = await executeTool(toolCall, async () => true);
    expect(result).toMatch(/^Error: invalid tool arguments/);
  });

  it('read_file refuses to read the credential file', async () => {
    const result = await executeTool(call('read_file', { path: defaultAuthPath() }), async () => true);
    expect(result).toBe('Error: refused to read credential file');
  });

  it('read_file refuses any path inside the auth directory, including via traversal', async () => {
    const authDir = path.dirname(defaultAuthPath());
    const sneaky = path.join(authDir, 'sub', '..', 'auth.json');
    const result = await executeTool(call('read_file', { path: sneaky }), async () => true);
    expect(result).toBe('Error: refused to read credential file');
  });

  it('isInsideDirectory guards a directory without touching the real auth path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-guard-'));
    expect(isInsideDirectory(path.join(dir, 'auth.json'), dir)).toBe(true);
    expect(isInsideDirectory(dir, dir)).toBe(true);
    expect(isInsideDirectory(path.join(dir, '..', 'elsewhere.txt'), dir)).toBe(false);
    expect(isInsideDirectory(path.join(os.tmpdir(), 'other.txt'), dir)).toBe(false);
  });

  it('write_file returns an error message when write fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    // Create a file at a path
    const filePath = path.join(dir, 'existing-file.txt');
    await fs.writeFile(filePath, 'content');
    // Try to write to a path where a parent directory is actually a file
    const invalidPath = path.join(filePath, 'subdir', 'file.txt');
    const result = await executeTool(
      call('write_file', { path: invalidPath, content: 'data' }),
      async () => true
    );
    expect(result).toMatch(/^Error:/);
  });
});
