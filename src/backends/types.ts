/**
 * Where a shell command actually runs, once run_command's approval gate,
 * read-only allowlist and dangerous-command warning have already decided it
 * may run at all. Nothing above this interface knows or cares which backend
 * is behind it — the confirm gate, output truncation, and untrusted-content
 * wrapping are identical no matter where the command executes.
 */
/**
 * How much tool output is retained for the model, across every tool that
 * produces potentially-large text (a file read, a command's output, an MCP
 * tool's result) — one cap, defined once, so it can't drift between them.
 */
export const MAX_OUTPUT_LENGTH = 4000;

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Live output as it arrives, for display — the model still gets the whole (capped) result via RunResult.output. */
  onOutput?: (chunk: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  /** Combined stdout+stderr, capped at MAX_OUTPUT_LENGTH. */
  output: string;
  timedOut: boolean;
  /**
   * Set when the process itself could not be run at all (e.g. spawn failed)
   * — a different failure mode than the command running and exiting non-zero.
   * When set, exitCode/output/timedOut carry no meaning.
   */
  spawnError?: string;
}

export interface ExecutionBackend {
  run(command: string, options: RunOptions): Promise<RunResult>;
  /** Releases whatever this session's backend is holding (e.g. a container). Idempotent. */
  dispose(): Promise<void>;
}

/**
 * What a session's execution backend is configured to be. Only 'docker'
 * exists so far. Lives here, not in gateway/session-service.ts, so
 * gateway/session-store.ts can reference the same shape for persistence
 * without importing session-service.ts back.
 */
export interface BackendConfig {
  kind: 'docker';
  image: string;
}
