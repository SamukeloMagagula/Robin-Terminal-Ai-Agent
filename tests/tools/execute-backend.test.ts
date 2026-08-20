import { describe, it, expect, vi } from 'vitest';
import { executeTool } from '../../src/tools/execute';
import type { ExecutionBackend, RunOptions, RunResult } from '../../src/backends/types';
import type { ToolCall } from '../../src/providers/types';

function call(name: string, args: unknown): ToolCall {
  return { id: 'call-1', name, arguments: JSON.stringify(args) };
}

function fakeBackend(result: RunResult): { backend: ExecutionBackend; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_command: string, _options: RunOptions) => result);
  return { backend: { run, dispose: vi.fn(async () => {}) }, run };
}

describe('run_command uses the injected backend, not a direct spawn', () => {
  it('formats a successful backend result as "Exit code: N" plus untrusted-wrapped output', async () => {
    const { backend, run } = fakeBackend({ exitCode: 0, output: 'hello', timedOut: false });

    const result = await executeTool(call('run_command', { command: 'echo hi' }), async () => true, {
      backend,
      cwd: '/some/dir',
    });

    expect(run).toHaveBeenCalledWith('echo hi', expect.objectContaining({ cwd: '/some/dir' }));
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('hello');
    expect(result).toContain('[UNTRUSTED CONTENT');
  });

  it('reports a non-zero exit code from the backend', async () => {
    const { backend } = fakeBackend({ exitCode: 3, output: 'boom', timedOut: false });

    const result = await executeTool(call('run_command', { command: 'false' }), async () => true, { backend });

    expect(result).toContain('Exit code: 3');
  });

  it('reports a timeout from the backend', async () => {
    const { backend } = fakeBackend({ exitCode: null, output: '', timedOut: true });

    const result = await executeTool(
      call('run_command', { command: 'sleep 999' }),
      async () => true,
      { backend, commandTimeoutMs: 500 }
    );

    expect(result).toMatch(/timed out after 0\.5s/);
  });

  it('reports a spawn error from the backend', async () => {
    const { backend } = fakeBackend({ exitCode: null, output: '', timedOut: false, spawnError: 'ENOENT' });

    const result = await executeTool(call('run_command', { command: 'anything' }), async () => true, { backend });

    expect(result).toBe('Error: ENOENT');
  });

  it('still auto-approves a read-only command without confirming, using the injected backend', async () => {
    const { backend, run } = fakeBackend({ exitCode: 0, output: 'ok', timedOut: false });
    let confirmed = false;

    await executeTool(call('run_command', { command: 'node --version' }), async () => {
      confirmed = true;
      return true;
    }, { backend });

    expect(confirmed).toBe(false);
    expect(run).toHaveBeenCalled();
  });

  it('falls back to real local execution when no backend is given', async () => {
    const result = await executeTool(
      call('run_command', { command: 'node -e "console.log(1+1)"' }),
      async () => true,
      {}
    );
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('2');
  });
});
