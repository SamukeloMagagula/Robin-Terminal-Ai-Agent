# Docker execution backend

Date: 2026-08-20

## Goal

Let `run_command` execute inside a Docker container instead of the host
machine directly, opt-in per session via `robin chat --backend
docker:<image>`. First of several planned execution backends (Hermes runs
terminal sessions in Docker, SSH, Singularity, Modal, Daytona, Vercel
Sandbox) — this spec covers Docker only. The others are genuinely separate
sub-projects: SSH is credential-light like Docker but has its own connection
lifecycle; Singularity is HPC-specific; Modal, Daytona and Vercel Sandbox are
each a distinct cloud SDK, billing account, and credential flow.

## Why this shape

**One abstraction seam, already found by reading the code.** `run_command`'s
actual process execution happens at exactly one call site —
`spawn(command, { shell: true, cwd })` in `execute.ts`'s `runCommandTool`.
Everything above that line — the read-only allowlist, the dangerous-command
warning, the confirm gate, output truncation, `wrapUntrusted` — stays
completely unchanged. Only the "how does this command actually run" step
becomes pluggable. This keeps the change small and contained: approval and
safety semantics are identical no matter where the command executes.

```ts
export interface ExecutionBackend {
  run(
    command: string,
    options: { cwd: string; timeoutMs: number; onOutput?: (chunk: string) => void }
  ): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;
}
```

`LocalBackend` wraps the existing spawn logic verbatim — same behavior,
same tests, just moved behind the interface. It is the default; nothing
changes for a session that never asks for `--backend`.

**Selection is a CLI flag, persisted on the session, not an env var.**
`robin chat --backend docker:node:20` — mirrors how `--continue` already
works. Persisted as a small config object
(`backend?: { kind: 'docker'; image: string }`) on `SessionRecord` (in
`session-service.ts`) and `PersistedSession` (in `session-store.ts`), because
it's a property of *this conversation*, not the whole profile the way
`ROBIN_PROFILE` is — one chat should be able to run in Docker while another,
on the same daemon, runs locally.

**No default image — a missing one is a clear startup error, not a guess.**
`--backend docker` alone fails immediately naming the fix
(`--backend docker:<image>`). A guessed default (some general-purpose Debian
image) would make `npm test` fail with no obvious cause the first time the
project needs a runtime the image doesn't have. Explicit is slower to try,
never silently wrong.

**A persistent container per session, not one-shot `docker run` per
command.** `run_command` fires many times across a session, and a fresh
container per call would pay image-pull/startup cost every time and lose
any state a previous command left behind (installed packages, temp files) —
exactly the two problems that make a real terminal session useful. So the
container starts lazily on the *first* `run_command` call for a session
(`docker run -d --rm -v <hostCwd>:/workspace -w /workspace <image> sleep
infinity`) and every subsequent call in that session is `docker exec -w
/workspace <containerId> sh -c "<command>"` against the same container.

**The mount target is a fixed `/workspace`, not the host's literal path.**
The host cwd could be `C:\Users\sam\project` on Windows or
`/home/sam/project` on Linux/Mac; picking a single container-side path
(`/workspace`) sidesteps drive-letter and path-separator translation
entirely rather than trying to mirror the host path 1:1 inside the
container. `read_file`/`write_file`/`edit_file` are **not** touched by this
spec at all — they keep reading and writing the real host path exactly as
they do today, since Docker only intercepts `run_command`'s execution step.
The bind mount is what keeps the two views of the same files in sync: a
command run inside the container sees exactly the files the file tools just
wrote on the host, just addressed as `/workspace/...` instead of the host's
own path.

**Cleanup happens on session close, not on process exit.**
`SessionService.close(id)` gains a call to the backend registry's
`dispose(id)`, which — for a Docker-backed session — runs `docker stop
<containerId>` (the container was started with `--rm`, so stopping it also
removes it). A gateway restart does **not** attempt to reattach to a
container from a previous daemon process: `PersistedSession`'s `backend`
field is only the *config* (image name), and a session restored via
`SessionService.restore()` with a Docker backend simply starts a fresh
container on its next `run_command` call — no attempt to track or reap
containers across daemon restarts in this pass. `robin doctor` or a manual
`docker ps`/`docker stop` is the answer if a daemon crash ever leaves one
running; documented, not automated, for v1.

## Backend registry

New `src/backends/` directory:

```ts
// src/backends/types.ts
export interface ExecutionBackend {
  run(command: string, options: RunOptions): Promise<RunResult>;
  /** Releases whatever this session's backend is holding (e.g. a container). */
  dispose(): Promise<void>;
}
```

```ts
// src/backends/local.ts
export class LocalBackend implements ExecutionBackend {
  async run(command, options) { /* exactly today's spawn logic, moved here */ }
  async dispose() {} // nothing to release
}
```

```ts
// src/backends/docker.ts
export interface DockerBackendOptions {
  image: string;
  hostCwd: string;
  /** Injectable for tests. Defaults to node:child_process.spawn. */
  spawn?: typeof spawn;
}

export class DockerBackend implements ExecutionBackend {
  private containerId: string | undefined;

  private async ensureContainer(): Promise<string> {
    if (this.containerId) return this.containerId;
    // docker run -d --rm -v <hostCwd>:/workspace -w /workspace <image> sleep infinity
    // Captures the printed container id from stdout.
  }

  async run(command, options) {
    const id = await this.ensureContainer();
    // docker exec -w /workspace <id> sh -c "<command>"
    // Same timeout/onOutput/truncation contract as LocalBackend.
  }

  async dispose() {
    if (this.containerId) await execDockerStop(this.containerId); // best-effort
  }
}
```

One `ExecutionBackend` instance per session, held by a new small registry
(`BackendRegistry` in `session-service.ts`'s deps, keyed by session id — same
shape as how `ApprovalRegistry` is keyed by session id already) — created
lazily when a session with `backend` config makes its first `run_command`
call, disposed when `SessionService.close(id)` runs.

## Wiring

`ExecuteOptions` (`tools/execute.ts`) gains `backend?: ExecutionBackend`.
`runCommandTool` calls `(options.backend ?? defaultLocalBackend).run(...)`
instead of constructing its own `spawn` call directly — the confirm gate,
read-only allowlist, dangerous-pattern warning, and output truncation are
completely unchanged; only the final execution step is redirected.

`TurnOptions` (`run-turn.ts`) gains the same `backend?: ExecutionBackend`,
threaded into the `executeTool(...)` call alongside `delegate`/`memory`/
`skills`/`media`, mirroring exactly how `delegate_task` was wired in.

`session-service.ts`'s `runOne` resolves the session's backend from the
registry (creating it lazily on first use if the session has `backend`
config and none exists yet) and passes it through. `create()` gains a
`backend?: { kind: 'docker'; image: string }` param, stored on
`SessionRecord` and included in what `persist()` writes.

`cli.ts`: `chat [provider]` gains `--backend <spec>`, parsed as
`kind:image` (only `docker:` recognized in this pass; any other prefix is a
clear "not a backend I know" error, not a silent local fallback).

## Testing

`tests/backends/local.test.ts` — the existing `run_command` test suite's
execution-specific cases (timeout, output truncation, exit code) moved to
exercise `LocalBackend` directly, proving the extraction changed nothing.

`tests/backends/docker.test.ts` — **two tiers**, since a real Docker daemon
isn't available in every CI environment:

1. **Command-construction tests** (always run): given a `spawn` fake that
   records what it was called with, assert the exact `docker run`/`docker
   exec`/`docker stop` argv — mount spec, working directory, `sh -c`
   wrapping, container id reuse across two `run()` calls, `dispose()`
   calling `stop` with the right id.
2. **Real-Docker integration test** (skipped when `docker` isn't on `PATH`
   or the daemon isn't reachable — checked once via `docker info` at suite
   start, same escape hatch `better-sqlite3`'s optional-native-module tests
   already use elsewhere in this codebase): starts a real container against
   a tiny image (`alpine`), runs an actual command, confirms real output and
   exit code, confirms `dispose()` actually removes the container
   (`docker ps` no longer lists it).

`tests/commands/*` / `tests/gateway/session-service*.test.ts` gain cases for
the `--backend docker:<image>` parsing (missing image → clear error,
unrecognized kind → clear error) and that `SessionService.close()` calls
`dispose()` on a session's backend.

## Out of scope

- SSH, Singularity, Modal, Daytona, Vercel Sandbox — separate sub-projects,
  noted above.
- Serverless hibernation (idle containers pausing/resuming) — not applicable
  to a plain local Docker container; relevant once Modal/Daytona are built.
- Reattaching to a container across a gateway restart. Config survives;
  container state does not, in this pass.
- Per-command image override, or switching a session's backend mid-conversation
  (`/backend` slash command). `--backend` is chosen once, at `robin chat`
  startup, for this pass.
- Resource limits (`--memory`, `--cpus`) on the container. Nothing in this
  spec prevents adding `docker run` flags for them later; just not decided
  or exposed yet.
- Routing `read_file`/`write_file`/`edit_file` through the container. They
  stay host-side, as explained above — the bind mount is what keeps the two
  views consistent without needing to.
