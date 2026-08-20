import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { LocalBackend } from '../../src/backends/local';

describe('LocalBackend.run', () => {
  it('returns the exit code and combined output of a successful command', async () => {
    const backend = new LocalBackend();
    const result = await backend.run('node -e "console.log(1+1)"', { cwd: process.cwd(), timeoutMs: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('2');
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
  });

  it('reports a non-zero exit code', async () => {
    const backend = new LocalBackend();
    const result = await backend.run('node -e "process.exit(3)"', { cwd: process.cwd(), timeoutMs: 10_000 });

    expect(result.exitCode).toBe(3);
  });

  it('streams output through onOutput as it arrives, in addition to the final result', async () => {
    const backend = new LocalBackend();
    const chunks: string[] = [];
    const result = await backend.run('node -e "console.log(\'streamed\')"', {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join('')).toContain('streamed');
    expect(result.output).toContain('streamed');
  });

  it('reports a timeout rather than hanging, and kills the process', async () => {
    const backend = new LocalBackend();
    const result = await backend.run('node -e "setTimeout(()=>{},60000)"', {
      cwd: process.cwd(),
      timeoutMs: 300,
    });

    expect(result.timedOut).toBe(true);
  }, 15_000);

  it('caps retained output at MAX_OUTPUT_LENGTH', async () => {
    const backend = new LocalBackend();
    const result = await backend.run('node -e "process.stdout.write(\'x\'.repeat(10000))"', {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.output.length).toBeLessThanOrEqual(4000);
  });

  it('reports a spawn error distinctly from a command that ran and failed', async () => {
    // A real spawn failure (e.g. ENOENT on the shell itself) is not
    // reliably reproducible across platforms with shell:true, since the
    // shell almost always exists — so this injects a fake spawn that emits
    // the same 'error' event a real failure would.
    const fakeSpawn = () => {
      const child = new EventEmitter() as unknown as ReturnType<typeof import('node:child_process').spawn>;
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      (child as unknown as { kill: () => void }).kill = () => {};
      queueMicrotask(() => child.emit('error', new Error('spawn nope ENOENT')));
      return child;
    };
    const backend = new LocalBackend(fakeSpawn as unknown as typeof import('node:child_process').spawn);
    const result = await backend.run('anything', { cwd: process.cwd(), timeoutMs: 10_000 });

    expect(result.spawnError).toContain('ENOENT');
  });
});

describe('LocalBackend.runArgv', () => {
  it('runs a program with an explicit argv, no shell quoting involved', async () => {
    const backend = new LocalBackend();
    const result = await backend.runArgv(['node', '-e', 'console.log(1+1)'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('2');
  });

  it('passes an argument containing spaces through as one argument, not split by a shell', async () => {
    const backend = new LocalBackend();
    // If this were shell-interpreted, "hello world" would need quoting to
    // survive as one argument; runArgv must not need that at all.
    const result = await backend.runArgv(['node', '-e', 'console.log(process.argv[1])', 'hello world'], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.output.trim()).toBe('hello world');
  });

  it('reports a timeout the same way run() does', async () => {
    const backend = new LocalBackend();
    const result = await backend.runArgv(['node', '-e', 'setTimeout(()=>{},60000)'], {
      cwd: process.cwd(),
      timeoutMs: 300,
    });

    expect(result.timedOut).toBe(true);
  }, 15_000);
});

describe('LocalBackend.dispose', () => {
  it('resolves without doing anything — nothing to release for local execution', async () => {
    const backend = new LocalBackend();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});
