import type { ExecutionBackend, RunOptions, RunResult } from './types.js';
import { LocalBackend } from './local.js';

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;

export interface DockerBackendOptions {
  image: string;
  /** The host directory bind-mounted into the container at /workspace. */
  hostCwd: string;
}

/**
 * What DockerBackend needs from its local runner: argv-based execution,
 * specifically. `docker` is invoked with an explicit argv, never a shell
 * string — a shell-quoted command built for POSIX sh is not generally valid
 * for Windows cmd.exe (single quotes group arguments in sh; cmd.exe does not
 * treat them specially, so a hand-escaped `sh -c '...'` string arrives at
 * docker exec split into the wrong number of arguments on Windows). An argv
 * array sidesteps quoting on both platforms, which the narrower
 * ExecutionBackend interface (a single command *string*) cannot express.
 */
export interface ArgvRunner {
  runArgv(args: [string, ...string[]], options: RunOptions): Promise<RunResult>;
}

/**
 * Runs commands inside a persistent Docker container for the life of one
 * session, rather than a fresh `docker run` per command — that would pay
 * image-pull/startup cost every call and lose whatever a previous command
 * left behind (installed packages, temp files), which is exactly what makes
 * a real terminal session useful.
 *
 * The `docker` CLI itself is just invoked as a local command — this wraps a
 * LocalBackend rather than spawning processes directly, inheriting the same
 * timeout/streaming/output-capture behavior for free.
 */
export class DockerBackend implements ExecutionBackend {
  private containerId: string | undefined;
  private starting: Promise<string> | undefined;

  constructor(
    private readonly options: DockerBackendOptions,
    private readonly local: ArgvRunner = new LocalBackend()
  ) {}

  private async ensureContainer(): Promise<string> {
    if (this.containerId) return this.containerId;
    // Two run() calls racing before the container exists must not each start
    // their own — only the first actually starts one, and the rest await it.
    if (!this.starting) {
      this.starting = this.startContainer().catch((err: unknown) => {
        // A failed start must not be cached forever — the next run() call
        // (e.g. after the user starts a Docker daemon that was briefly
        // down) has to be able to try again, not replay the same rejection
        // for the rest of the session.
        this.starting = undefined;
        throw err;
      });
    }
    this.containerId = await this.starting;
    return this.containerId;
  }

  private async startContainer(): Promise<string> {
    const { image, hostCwd } = this.options;
    const result = await this.local.runArgv(
      ['docker', 'run', '-d', '--rm', '-v', `${hostCwd}:/workspace`, '-w', '/workspace', image, 'sleep', 'infinity'],
      { cwd: hostCwd, timeoutMs: START_TIMEOUT_MS }
    );

    if (result.spawnError !== undefined) {
      throw new Error(`Failed to start Docker container (${image}): ${result.spawnError}`);
    }
    if (result.timedOut) {
      throw new Error(`Starting the Docker container (${image}) timed out.`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start Docker container (${image}): ${result.output.trim()}`);
    }
    const id = result.output.trim().split('\n').pop() ?? '';
    if (!id) {
      throw new Error(`Docker did not print a container id for image "${image}".`);
    }
    return id;
  }

  async run(command: string, options: RunOptions): Promise<RunResult> {
    const containerId = await this.ensureContainer();
    return this.local.runArgv(
      ['docker', 'exec', '-w', '/workspace', containerId, 'sh', '-c', command],
      options
    );
  }

  async dispose(): Promise<void> {
    if (!this.containerId) return;
    const id = this.containerId;
    this.containerId = undefined;
    this.starting = undefined;
    // Best-effort: the container was started with --rm, so a successful stop
    // also removes it. A failure here (daemon already gone, container
    // already stopped) is not this session's problem to surface.
    await this.local
      .runArgv(['docker', 'stop', id], { cwd: this.options.hostCwd, timeoutMs: STOP_TIMEOUT_MS })
      .catch(() => undefined);
  }
}
