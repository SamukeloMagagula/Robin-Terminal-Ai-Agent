import { spawn as nodeSpawn } from 'node:child_process';
import { MAX_OUTPUT_LENGTH, type ExecutionBackend, type RunOptions, type RunResult } from './types.js';

/**
 * Runs a command directly on this machine — the only backend that existed
 * before backends did.
 *
 * Also the thing DockerBackend invokes `docker` itself through (see
 * runArgv) — `docker` is just a local command from this machine's point of
 * view, so there is no reason to reimplement process spawning a second time.
 */
export class LocalBackend implements ExecutionBackend {
  constructor(private readonly spawnImpl: typeof nodeSpawn = nodeSpawn) {}

  /** Runs a shell command string — pipes, redirects, everything a real shell provides. */
  async run(command: string, options: RunOptions): Promise<RunResult> {
    return this.spawnAndCollect(this.spawnImpl(command, { shell: true, cwd: options.cwd }), options);
  }

  /**
   * Runs a program with an explicit argv, no shell involved.
   *
   * Necessary for anything that has to work identically whether the host
   * shell is POSIX sh or Windows cmd.exe — a shell-quoted string built for
   * one is not generally valid for the other (single quotes group arguments
   * in sh; cmd.exe does not treat them specially at all, so `sh -c
   * 'node --version'` arrives at docker exec as four separate arguments on
   * Windows, not one). An argv array sidesteps quoting entirely: each
   * element is one argument, passed through as-is by Node on every platform.
   */
  async runArgv(args: [string, ...string[]], options: RunOptions): Promise<RunResult> {
    const [file, ...rest] = args;
    return this.spawnAndCollect(this.spawnImpl(file, rest, { shell: false, cwd: options.cwd }), options);
  }

  private spawnAndCollect(
    child: ReturnType<typeof nodeSpawn>,
    options: RunOptions
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      let output = '';
      let settled = false;

      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // Without a timeout a command that waits on stdin (which it never gets
      // — the REPL owns it) hangs the whole session with no way back to the
      // prompt.
      //
      // The timeout resolves immediately rather than waiting for 'close'.
      // With shell:true the child is the shell, and killing it does not
      // necessarily reap a grandchild still holding stdio open — waiting for
      // 'close' meant a 500ms timeout took 15 seconds to report. The kill is
      // still attempted; the promise simply does not depend on it succeeding.
      const timer = setTimeout(() => {
        child.kill();
        finish({ exitCode: null, output, timedOut: true });
      }, options.timeoutMs);

      const collect = (chunk: Buffer): void => {
        const text = chunk.toString();
        // Cap what is retained for the model, but keep streaming to the
        // display — someone watching a long build still wants to see it finish.
        if (output.length < MAX_OUTPUT_LENGTH) output += text;
        options.onOutput?.(text);
      };
      // Never actually null here — neither run() nor runArgv() customizes
      // stdio, so spawn always gives back pipes for both.
      child.stdout!.on('data', collect);
      child.stderr!.on('data', collect);

      child.on('error', (err) => {
        finish({ exitCode: null, output, timedOut: false, spawnError: err.message });
      });

      child.on('close', (code) => {
        finish({ exitCode: code, output: output.slice(0, MAX_OUTPUT_LENGTH), timedOut: false });
      });
    });
  }

  async dispose(): Promise<void> {
    // Nothing to release for direct local execution.
  }
}
