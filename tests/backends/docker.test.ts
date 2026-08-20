import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { DockerBackend, type ArgvRunner } from '../../src/backends/docker';
import { LocalBackend } from '../../src/backends/local';
import type { RunOptions, RunResult } from '../../src/backends/types';

function fakeLocal(script: (args: string[]) => RunResult) {
  const runArgv = vi.fn(async (args: [string, ...string[]], _options: RunOptions) => script(args));
  const local: ArgvRunner = { runArgv };
  return { local, runArgv };
}

const opts = { image: 'alpine', hostCwd: '/host/project' };

describe('DockerBackend.run — container lifecycle (argv construction, no real Docker)', () => {
  it('starts a persistent container on the first run(), mounting hostCwd at /workspace', async () => {
    const { local, runArgv } = fakeLocal((args) =>
      args[1] === 'run'
        ? { exitCode: 0, output: 'abc123\n', timedOut: false }
        : { exitCode: 0, output: 'ok', timedOut: false }
    );
    const docker = new DockerBackend(opts, local);

    await docker.run('echo hi', { cwd: '/workspace', timeoutMs: 10_000 });

    const runCall = runArgv.mock.calls.find((c) => c[0][1] === 'run');
    expect(runCall).toBeDefined();
    const args = runCall![0];
    expect(args).toEqual([
      'docker',
      'run',
      '-d',
      '--rm',
      '-v',
      '/host/project:/workspace',
      '-w',
      '/workspace',
      'alpine',
      'sleep',
      'infinity',
    ]);
  });

  it('execs the command in the existing container on the first run(), as one argv element with no shell quoting', async () => {
    const { local, runArgv } = fakeLocal((args) =>
      args[1] === 'run'
        ? { exitCode: 0, output: 'abc123\n', timedOut: false }
        : { exitCode: 0, output: 'hi\n', timedOut: false }
    );
    const docker = new DockerBackend(opts, local);

    const result = await docker.run('echo hi', { cwd: '/workspace', timeoutMs: 10_000 });

    const execCall = runArgv.mock.calls.find((c) => c[0][1] === 'exec');
    expect(execCall).toBeDefined();
    expect(execCall![0]).toEqual(['docker', 'exec', '-w', '/workspace', 'abc123', 'sh', '-c', 'echo hi']);
    expect(result.output).toBe('hi\n');
  });

  it('reuses the same container on a second run(), without starting a new one', async () => {
    const { local, runArgv } = fakeLocal((args) =>
      args[1] === 'run'
        ? { exitCode: 0, output: 'abc123\n', timedOut: false }
        : { exitCode: 0, output: 'ok', timedOut: false }
    );
    const docker = new DockerBackend(opts, local);

    await docker.run('one', { cwd: '/workspace', timeoutMs: 10_000 });
    await docker.run('two', { cwd: '/workspace', timeoutMs: 10_000 });

    expect(runArgv.mock.calls.filter((c) => c[0][1] === 'run')).toHaveLength(1);
    expect(runArgv.mock.calls.filter((c) => c[0][1] === 'exec')).toHaveLength(2);
  });

  it('starts only one container when two run() calls race before the container exists', async () => {
    let runStarts = 0;
    const { local } = fakeLocal((args) => {
      if (args[1] === 'run') runStarts++;
      return args[1] === 'run'
        ? { exitCode: 0, output: 'abc123\n', timedOut: false }
        : { exitCode: 0, output: 'ok', timedOut: false };
    });
    const docker = new DockerBackend(opts, local);

    await Promise.all([
      docker.run('one', { cwd: '/workspace', timeoutMs: 10_000 }),
      docker.run('two', { cwd: '/workspace', timeoutMs: 10_000 }),
    ]);

    expect(runStarts).toBe(1);
  });

  it('passes a command containing single and double quotes through as one argument, unmodified', async () => {
    const { local, runArgv } = fakeLocal((args) =>
      args[1] === 'run'
        ? { exitCode: 0, output: 'abc123\n', timedOut: false }
        : { exitCode: 0, output: 'ok', timedOut: false }
    );
    const docker = new DockerBackend(opts, local);

    const tricky = `echo "it's a \\"test\\""`;
    await docker.run(tricky, { cwd: '/workspace', timeoutMs: 10_000 });

    const execCall = runArgv.mock.calls.find((c) => c[0][1] === 'exec');
    // No shell in between means no escaping is needed or performed — the
    // command arrives at sh -c exactly as the model wrote it.
    expect(execCall![0].at(-1)).toBe(tricky);
  });

  it('throws a clear error when the container fails to start', async () => {
    const { local } = fakeLocal(() => ({
      exitCode: 1,
      output: "Unable to find image 'nope' locally",
      timedOut: false,
    }));
    const docker = new DockerBackend({ image: 'nope', hostCwd: '/host/project' }, local);

    await expect(docker.run('echo hi', { cwd: '/workspace', timeoutMs: 10_000 })).rejects.toThrow(/nope/);
  });

  it('retries starting the container on a later run() after an earlier start failed', async () => {
    let attempt = 0;
    const { local, runArgv } = fakeLocal((args) => {
      if (args[1] !== 'run') return { exitCode: 0, output: 'ok', timedOut: false };
      attempt++;
      return attempt === 1
        ? { exitCode: 1, output: 'daemon not running', timedOut: false }
        : { exitCode: 0, output: 'abc123\n', timedOut: false };
    });
    const docker = new DockerBackend(opts, local);

    await expect(docker.run('one', { cwd: '/workspace', timeoutMs: 10_000 })).rejects.toThrow(
      /daemon not running/
    );
    // The daemon is "back" now — a later run() must actually retry, not
    // replay the same cached rejection forever.
    const result = await docker.run('two', { cwd: '/workspace', timeoutMs: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(runArgv.mock.calls.filter((c) => c[0][1] === 'run')).toHaveLength(2);
  });
});

describe('DockerBackend.dispose', () => {
  it('stops the container by id, and a later run() starts a fresh one', async () => {
    let containerCounter = 0;
    const { local, runArgv } = fakeLocal((args) => {
      if (args[1] === 'run') {
        containerCounter++;
        return { exitCode: 0, output: `container-${containerCounter}\n`, timedOut: false };
      }
      return { exitCode: 0, output: 'ok', timedOut: false };
    });
    const docker = new DockerBackend(opts, local);

    await docker.run('one', { cwd: '/workspace', timeoutMs: 10_000 });
    await docker.dispose();

    const stopCall = runArgv.mock.calls.find((c) => c[0][1] === 'stop');
    expect(stopCall).toBeDefined();
    expect(stopCall![0]).toEqual(['docker', 'stop', 'container-1']);

    await docker.run('two', { cwd: '/workspace', timeoutMs: 10_000 });
    expect(runArgv.mock.calls.filter((c) => c[0][1] === 'run')).toHaveLength(2);
  });

  it('does nothing when no container was ever started', async () => {
    const { local, runArgv } = fakeLocal(() => ({ exitCode: 0, output: '', timedOut: false }));
    const docker = new DockerBackend(opts, local);

    await docker.dispose();

    expect(runArgv).not.toHaveBeenCalled();
  });
});

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())('DockerBackend — real Docker integration', () => {
  it('runs a real command in a real container and cleans it up on dispose', async () => {
    const docker = new DockerBackend({ image: 'alpine', hostCwd: process.cwd() }, new LocalBackend());
    try {
      const result = await docker.run('echo real-docker-test', { cwd: '/workspace', timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('real-docker-test');
    } finally {
      await docker.dispose();
    }
  }, 60_000);
});
