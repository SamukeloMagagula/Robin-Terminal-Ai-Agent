import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeTool, type ConfirmRequest } from '../../src/tools/execute';
import type { ToolCall } from '../../src/providers/types';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call-1', name, arguments: JSON.stringify(args) };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'robin-subject-'));
}

function recorder() {
  const seen: ConfirmRequest[] = [];
  const confirm = vi.fn(async (request: ConfirmRequest) => {
    seen.push(request);
    return false;
  });
  return { seen, confirm };
}

describe('ConfirmRequest.subject', () => {
  it('carries the raw command for run_command', async () => {
    const { seen, confirm } = recorder();

    await executeTool(call('run_command', { command: 'restic backup /data' }), confirm, {
      cwd: await tempDir(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].subject).toBe('restic backup /data');
  });

  it('carries the canonical absolute path for write_file', async () => {
    const dir = await tempDir();
    const { seen, confirm } = recorder();

    await executeTool(call('write_file', { path: 'notes.md', content: 'hi' }), confirm, { cwd: dir });

    expect(seen).toHaveLength(1);
    expect(path.isAbsolute(seen[0].subject)).toBe(true);
    expect(path.basename(seen[0].subject)).toBe('notes.md');
  });

  it('carries the canonical absolute path for read_file outside the cwd', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    const target = path.join(outside, 'secret.txt');
    await fs.writeFile(target, 'x');
    const { seen, confirm } = recorder();

    await executeTool(call('read_file', { path: target }), confirm, { cwd: dir });

    expect(seen).toHaveLength(1);
    expect(path.basename(seen[0].subject)).toBe('secret.txt');
  });

  it('carries the namespaced name for an MCP tool', async () => {
    const { seen, confirm } = recorder();

    await executeTool(call('github.create_issue', { title: 'x' }), confirm, {
      cwd: await tempDir(),
      mcp: {
        has: (name: string) => name === 'github.create_issue',
        call: async () => 'unused',
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].subject).toBe('github.create_issue');
  });

  it('carries the canonical path for edit_file', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello world');
    const { seen, confirm } = recorder();

    await executeTool(
      call('edit_file', { path: 'a.txt', old_string: 'hello', new_string: 'goodbye' }),
      confirm,
      { cwd: dir }
    );

    expect(seen).toHaveLength(1);
    expect(path.basename(seen[0].subject)).toBe('a.txt');
  });
});
