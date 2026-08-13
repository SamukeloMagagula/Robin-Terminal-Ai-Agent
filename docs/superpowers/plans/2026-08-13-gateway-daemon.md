# Gateway Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move session ownership out of `robin chat` and `robin serve` into a long-running local daemon, so one live conversation can be driven from the terminal and Telegram at once, with tool approvals answerable at the keyboard.

**Architecture:** A single loopback WebSocket daemon owns `SessionList`, the file-backed stores and the MCP registry, and runs turns by calling the existing `runTurn` unchanged. Every surface — the REPL, the Telegram bridge — becomes a thin client that sends prompts and renders streamed events. The daemon's logic (`session-service.ts`, `approvals.ts`) knows nothing about sockets and is tested without one.

**Tech Stack:** TypeScript (ESM, NodeNext), Node >= 18, vitest, `ws` for the WebSocket server and client, `@inquirer/prompts` for terminal prompts, chalk for output.

**Spec:** `docs/superpowers/specs/2026-08-13-gateway-daemon-design.md`

## Global Constraints

- Node >= 18. Nothing may require a newer floor without changing `README.md` and `src/startup/preflight.ts`.
- Dependencies are **exact-pinned, no ranges** (see the `"//dependencies"` note in `package.json`). Install with `npm ci`.
- Default port **18790**, overridable with `ROBIN_GATEWAY_PORT`. 18789 is deliberately avoided (OpenClaw uses it).
- Protocol version constant is **1** for this milestone. Any frame shape change during implementation bumps it.
- Gateway state file: `~/.robin/gateway.json`, mode **0600**, in a directory created mode **0700**.
- Bind **loopback only** (`127.0.0.1`). Never `0.0.0.0`.
- Approval timeout: **5 minutes**.
- Windows is a first-class target — the developer runs Windows 11. No POSIX-only syscalls, no shell assumptions, and `fs.chmod` is skipped on `win32` (follow the existing pattern in `src/trust-store.ts:105`).
- Tests live under `tests/` mirroring `src/`, and every store constructor takes a file path so tests never touch the real `~/.robin`. See `tests/repl/run-turn.test.ts:11` for the established pattern and why.
- Comments explain **why**, not what. Match the surrounding voice — see `src/providers/unsupported-models.ts` for the register.
- `npm run check` (typecheck + 873 existing tests + build) must pass at every commit.

## Spec correction found while planning

The spec lists `tools/` under "Unchanged". That is wrong: executing tools in the
session's recorded working directory requires threading a `cwd` through
`executeTool`, because `runCommandTool` currently inherits the daemon's cwd via
`spawn` and `isInsideCwd` reads `process.cwd()` directly
(`src/tools/execute.ts:192`). **Task 3** does this, and the spec should be
amended when that task lands.

## File Structure

| File | Responsibility |
|---|---|
| `src/gateway/protocol.ts` (new) | Frame and event types, `PROTOCOL_VERSION`, `parseFrame`. No behaviour. |
| `src/gateway/discovery.ts` (new) | `~/.robin/gateway.json` read/write, liveness, stale detection. |
| `src/gateway/approvals.ts` (new) | Pending-approval registry; produces the `ConfirmFn` handed to `runTurn`. |
| `src/gateway/session-service.ts` (new) | Owns `SessionList` + stores; runs turns; per-session FIFO queue. Socket-free. |
| `src/gateway/server.ts` (new) | WebSocket server, auth, connection registry, frame dispatch, broadcast. |
| `src/gateway/client.ts` (new) | Client connection: id-matched request/response, typed event stream. |
| `src/gateway/ensure.ts` (new) | Spawn-detached-and-wait, `EADDRINUSE` race handling. |
| `src/commands/gateway-command.ts` (new) | `robin gateway start\|stop\|status`. |
| `src/tools/execute.ts` (modify) | Accept a `cwd` for command execution and containment checks. |
| `src/repl/run-repl.ts` (modify) | Becomes a client: connect, render events, dispatch commands. |
| `src/repl/repl-context.ts` (modify) | `ctx.client` replaces `ctx.sessions` and most of `ctx.stores`. |
| `src/repl/commands/*.ts` (modify) | Session-mutating handlers become RPC calls. |
| `src/channels/bridge.ts` (modify) | Loses sessions/stores/queues; becomes a client. |
| `src/commands/doctor-command.ts` (modify) | Gateway health check. |
| `src/cli.ts` (modify) | `gateway` command; `chat` ensures a daemon. |
| `src/repl/approval-gate.ts` (delete in Task 4) | Its policy moves into `approvals.ts`. |

---

### Task 1: Protocol types

**Files:**
- Create: `src/gateway/protocol.ts`
- Test: `tests/gateway/protocol.test.ts`
- Modify: `package.json` (add `ws`, `@types/ws`)

**Interfaces:**
- Consumes: `Message`, `Provider` from `src/providers/types.js`; `ConfirmRequest` from `src/tools/execute.js`.
- Produces: `PROTOCOL_VERSION`, `Frame`, `RequestFrame`, `ResponseFrame`, `EventFrame`, `GatewayEvent`, `SessionSnapshot`, `ApprovalOrigin`, `parseFrame(raw: string): Frame | undefined`.

- [ ] **Step 1: Add the dependency**

```bash
npm install --save-exact ws@8.18.3
npm install --save-exact --save-dev @types/ws@8.18.1
```

Confirm `package.json` shows bare versions with no `^`. If npm wrote a range, fix it by hand and re-run `npm install` to regenerate the lockfile.

- [ ] **Step 2: Write the failing test**

Create `tests/gateway/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseFrame, PROTOCOL_VERSION } from '../../src/gateway/protocol';

describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('parseFrame', () => {
  it('reads a request frame', () => {
    const frame = parseFrame('{"type":"req","id":"1","method":"session.list","params":{}}');
    expect(frame).toEqual({ type: 'req', id: '1', method: 'session.list', params: {} });
  });

  it('reads an event frame', () => {
    const raw = '{"type":"event","sessionId":1,"event":{"kind":"text","turnId":"t1","delta":"hi"}}';
    expect(parseFrame(raw)).toMatchObject({ type: 'event', sessionId: 1 });
  });

  // A frame arrives from a socket. Anything can be on the other end of a
  // socket, and a malformed frame must not take the daemon down.
  it.each([
    'not json',
    '[]',
    'null',
    '{"type":"nope"}',
    '{"type":"req"}',
    '{"type":"req","id":1,"method":"x","params":{}}',
    '{"type":"res","id":"1"}',
  ])('rejects %s', (raw) => {
    expect(parseFrame(raw)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/gateway/protocol.test.ts`
Expected: FAIL — cannot resolve `src/gateway/protocol`.

- [ ] **Step 4: Write the module**

Create `src/gateway/protocol.ts`:

```ts
import type { Message } from '../providers/types.js';
import type { ConfirmRequest } from '../tools/execute.js';

/**
 * Bumped whenever a frame shape changes.
 *
 * This exists because `robin chat` auto-starts a daemon: after a rebuild an
 * old daemon is still listening, and a new client talking an old protocol to
 * it produces failures that look like anything but the real cause.
 */
export const PROTOCOL_VERSION = 1;

/** What a client is and what it may be asked to do. */
export type ClientKind = 'terminal' | 'channel';

/** Who caused a turn, so an approval box can say where the request came from. */
export interface ApprovalOrigin {
  /** "terminal", "telegram", ... */
  surface: string;
  /** Sender id or name, where the surface has one. Display only. */
  who?: string;
}

/** A session as clients see it. Never contains history — that comes from attach. */
export interface SessionSnapshot {
  id: number;
  label?: string;
  providerId: string;
  providerName: string;
  model: string;
  cwd: string;
  toolsEnabled: boolean;
  autoApprove: boolean;
  turnCount: number;
  systemPrompt?: string;
  /** A turn is running right now. */
  busy: boolean;
  /** Prompts waiting behind it. */
  queued: number;
}

export type GatewayEvent =
  | { kind: 'turn.started'; turnId: string; providerName: string; model: string }
  | { kind: 'text'; turnId: string; delta: string }
  | { kind: 'thinking'; turnId: string; delta: string }
  | { kind: 'tool.auto_approved'; turnId: string; command: string }
  | { kind: 'tool.output'; turnId: string; chunk: string }
  | {
      kind: 'approval.request';
      approvalId: string;
      request: ConfirmRequest;
      origin: ApprovalOrigin;
    }
  | { kind: 'approval.resolved'; approvalId: string; approved: boolean; by: string }
  | { kind: 'fallback'; turnId: string; message: string; providerName: string; model: string }
  | { kind: 'trim'; turnId: string; dropped: number; limit: number }
  | {
      kind: 'turn.finished';
      turnId: string;
      ok: boolean;
      aborted: boolean;
      providerName: string;
      model: string;
      error?: string;
    }
  | { kind: 'session.changed'; snapshot: SessionSnapshot };

export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type ResponseFrame =
  | { type: 'res'; id: string; ok: true; result: unknown }
  | { type: 'res'; id: string; ok: false; error: { code: string; message: string } };

export interface EventFrame {
  type: 'event';
  /** Absent for events that are not about one session. */
  sessionId?: number;
  event: GatewayEvent;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

/** Result of `session.attach`. */
export interface AttachResult {
  snapshot: SessionSnapshot;
  history: Message[];
}

/** Result of `prompt.send`. Two-stage: accepted now, `turn.finished` later. */
export interface PromptAccepted {
  turnId: string;
  /** 0 means it started immediately. */
  queuePosition: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses a frame off the wire, returning undefined for anything malformed.
 *
 * Deliberately total: the caller closes the connection on undefined rather
 * than throwing, because an exception here would be thrown inside a socket
 * event handler where there is nothing useful to catch it.
 */
export function parseFrame(raw: string): Frame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (parsed.type === 'req') {
    if (typeof parsed.id !== 'string' || typeof parsed.method !== 'string') return undefined;
    if (!isRecord(parsed.params)) return undefined;
    return parsed as unknown as RequestFrame;
  }
  if (parsed.type === 'res') {
    if (typeof parsed.id !== 'string' || typeof parsed.ok !== 'boolean') return undefined;
    if (parsed.ok === false && !isRecord(parsed.error)) return undefined;
    return parsed as unknown as ResponseFrame;
  }
  if (parsed.type === 'event') {
    if (!isRecord(parsed.event) || typeof parsed.event.kind !== 'string') return undefined;
    return parsed as unknown as EventFrame;
  }
  return undefined;
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/gateway/protocol.test.ts`
Expected: PASS (12 assertions).

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.test.json
git add package.json package-lock.json src/gateway/protocol.ts tests/gateway/protocol.test.ts
git commit -m "gateway: the frame types both halves agree on"
```

---

### Task 2: Gateway discovery file

**Files:**
- Create: `src/gateway/discovery.ts`
- Test: `tests/gateway/discovery.test.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION` from `src/gateway/protocol.js`.
- Produces: `GatewayInfo`, `defaultGatewayInfoPath()`, `readGatewayInfo(path?)`, `writeGatewayInfo(info, path?)`, `removeGatewayInfo(path?)`, `isProcessAlive(pid)`, `readLiveGatewayInfo(path?)`, `defaultPort()`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/discovery.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readGatewayInfo,
  writeGatewayInfo,
  removeGatewayInfo,
  readLiveGatewayInfo,
  isProcessAlive,
  defaultPort,
  type GatewayInfo,
} from '../../src/gateway/discovery';
import { PROTOCOL_VERSION } from '../../src/gateway/protocol';

function throwawayPath(): string {
  return path.join(os.tmpdir(), `robin-gateway-${Date.now()}-${Math.random()}.json`);
}

const info: GatewayInfo = {
  port: 18790,
  pid: process.pid,
  token: 'a-token',
  protocol: PROTOCOL_VERSION,
};

describe('gateway info file', () => {
  it('round-trips', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(info, file);
    expect(await readGatewayInfo(file)).toEqual(info);
  });

  it('reads as absent when the file does not exist', async () => {
    expect(await readGatewayInfo(throwawayPath())).toBeUndefined();
  });

  // Fails closed, like TrustStore: a corrupt file must mean "start fresh",
  // never "crash on startup".
  it.each(['not json', '{}', '{"port":"nope","pid":1,"token":"t","protocol":1}'])(
    'reads as absent when the file is %s',
    async (contents) => {
      const file = throwawayPath();
      await fs.writeFile(file, contents, 'utf-8');
      expect(await readGatewayInfo(file)).toBeUndefined();
    }
  );

  it('removes the file, and does not mind if it is already gone', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(info, file);
    await removeGatewayInfo(file);
    expect(await readGatewayInfo(file)).toBeUndefined();
    await expect(removeGatewayInfo(file)).resolves.toBeUndefined();
  });
});

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for a pid that cannot exist', () => {
    expect(isProcessAlive(0x7ffffff0)).toBe(false);
  });
});

describe('readLiveGatewayInfo', () => {
  it('returns the info when the recorded process is alive', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(info, file);
    expect(await readLiveGatewayInfo(file)).toEqual(info);
  });

  it('returns nothing when the recorded process is gone', async () => {
    const file = throwawayPath();
    await writeGatewayInfo({ ...info, pid: 0x7ffffff0 }, file);
    expect(await readLiveGatewayInfo(file)).toBeUndefined();
  });
});

describe('defaultPort', () => {
  const original = process.env.ROBIN_GATEWAY_PORT;
  afterEach(() => {
    if (original === undefined) delete process.env.ROBIN_GATEWAY_PORT;
    else process.env.ROBIN_GATEWAY_PORT = original;
  });

  it('is 18790 by default', () => {
    delete process.env.ROBIN_GATEWAY_PORT;
    expect(defaultPort()).toBe(18790);
  });

  it('honours ROBIN_GATEWAY_PORT', () => {
    process.env.ROBIN_GATEWAY_PORT = '20000';
    expect(defaultPort()).toBe(20000);
  });

  it('ignores a nonsense ROBIN_GATEWAY_PORT rather than binding somewhere random', () => {
    process.env.ROBIN_GATEWAY_PORT = 'banana';
    expect(defaultPort()).toBe(18790);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/gateway/discovery.test.ts`
Expected: FAIL — cannot resolve `src/gateway/discovery`.

- [ ] **Step 3: Write the module**

Create `src/gateway/discovery.ts`:

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PROTOCOL_VERSION } from './protocol.js';

/** 18789 is OpenClaw's. A machine may reasonably run both. */
const DEFAULT_PORT = 18790;

export interface GatewayInfo {
  port: number;
  pid: number;
  token: string;
  /** The protocol this daemon speaks — lets a client spot skew before connecting. */
  protocol: number;
}

export function defaultGatewayInfoPath(): string {
  return path.join(os.homedir(), '.robin', 'gateway.json');
}

export function defaultPort(): number {
  const configured = Number(process.env.ROBIN_GATEWAY_PORT);
  return Number.isInteger(configured) && configured > 0 && configured < 65536
    ? configured
    : DEFAULT_PORT;
}

function isGatewayInfo(value: unknown): value is GatewayInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.port === 'number' &&
    typeof info.pid === 'number' &&
    typeof info.token === 'string' &&
    typeof info.protocol === 'number'
  );
}

export async function readGatewayInfo(
  filePath: string = defaultGatewayInfoPath()
): Promise<GatewayInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return isGatewayInfo(parsed) ? parsed : undefined;
  } catch {
    // Missing or corrupt both mean the same thing to every caller: there is no
    // gateway to talk to. Start a fresh one.
    return undefined;
  }
}

/**
 * Writes the file the whole discovery mechanism rests on.
 *
 * 0600 is not decoration: anything that can read this token can open the
 * socket, and anything that can open the socket can run commands as this user.
 */
export async function writeGatewayInfo(
  info: GatewayInfo,
  filePath: string = defaultGatewayInfoPath()
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(info, null, 2), { mode: 0o600 });
  // writeFile's mode applies only on creation, so a file that already exists
  // with looser permissions would silently keep them.
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

export async function removeGatewayInfo(
  filePath: string = defaultGatewayInfoPath()
): Promise<void> {
  await fs.rm(filePath, { force: true });
}

/** Signal 0 tests for existence without delivering anything. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The info file, but only when the process it names is still running.
 *
 * A crashed daemon leaves its file behind. Treating that as "a gateway is up"
 * would make every client hang on a connect to a closed port.
 */
export async function readLiveGatewayInfo(
  filePath: string = defaultGatewayInfoPath()
): Promise<GatewayInfo | undefined> {
  const info = await readGatewayInfo(filePath);
  if (!info) return undefined;
  return isProcessAlive(info.pid) ? info : undefined;
}

export { PROTOCOL_VERSION };
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gateway/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.test.json
git add src/gateway/discovery.ts tests/gateway/discovery.test.ts
git commit -m "gateway: find the daemon, or find out it is not there"
```

---

### Task 3: Run tools in the session's working directory

**Files:**
- Modify: `src/tools/execute.ts`
- Modify: `src/repl/run-turn.ts` (pass `cwd` through `TurnOptions`)
- Test: `tests/tools/execute-cwd.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExecuteOptions.cwd?: string`; `TurnOptions.cwd?: string`. Both default to `process.cwd()`, so every existing caller is unaffected.

**Why this task exists:** the daemon has one working directory; sessions have
their own. Without this, "run the tests" from a session created in a repo runs
them in the daemon's directory.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/execute-cwd.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeTool } from '../../src/tools/execute';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-cwd-'));
  await fs.writeFile(path.join(dir, 'marker.txt'), 'found me', 'utf-8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('executeTool with a cwd', () => {
  it('runs a command in the given directory, not the process one', async () => {
    const result = await executeTool(
      { id: '1', name: 'run_command', arguments: JSON.stringify({ command: 'node -e "console.log(process.cwd())"' }) },
      async () => true,
      { cwd: dir }
    );
    // realpath because macOS reports /var as /private/var; harmless elsewhere.
    expect(result).toContain(await fs.realpath(dir));
  });

  it('treats a relative read as relative to that directory', async () => {
    const result = await executeTool(
      { id: '2', name: 'read_file', arguments: JSON.stringify({ path: 'marker.txt' }) },
      async () => false, // a prompt here would mean it thought the file was outside
      { cwd: dir }
    );
    expect(result).toContain('found me');
  });

  it('still asks before reading outside that directory', async () => {
    const outside = path.join(os.tmpdir(), `robin-outside-${Date.now()}.txt`);
    await fs.writeFile(outside, 'secret', 'utf-8');
    let asked = false;

    const result = await executeTool(
      { id: '3', name: 'read_file', arguments: JSON.stringify({ path: outside }) },
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
      { id: '4', name: 'run_command', arguments: JSON.stringify({ command: 'node -e "console.log(process.cwd())"' }) },
      async () => true,
      {}
    );
    expect(result).toContain(process.cwd());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tools/execute-cwd.test.ts`
Expected: FAIL — commands run in the repo directory, and the relative read resolves against it.

- [ ] **Step 3: Thread `cwd` through `execute.ts`**

In `src/tools/execute.ts`:

Add to `ExecuteOptions`:

```ts
  /**
   * Where file paths resolve and commands run. Defaults to the process's own
   * directory, which is right for the REPL and wrong for the daemon: one
   * daemon serves sessions created in different repositories.
   */
  cwd?: string;
```

Change `executeTool`'s dispatch to pass it. `read_file` and `write_file` need
it for containment, `run_command` for execution:

```ts
      case 'read_file':
        return await readFileTool(requireString(args.path, 'path'), confirm, options.cwd);
      case 'write_file':
        return await writeFileTool(
          requireString(args.path, 'path'),
          requireString(args.content, 'content'),
          confirm,
          options.cwd
        );
      case 'run_command':
        return await runCommandTool(
          requireString(args.command, 'command'),
          confirm,
          options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
          options.onAutoApproved,
          options.onOutput,
          options.cwd
        );
```

Resolve relative paths against the session directory before the sensitive-path
check, and make containment relative to it:

```ts
async function readFileTool(
  filePath: string,
  confirm: ConfirmFn,
  cwd: string = process.cwd(),
  sensitiveDirs = defaultSensitiveDirs()
): Promise<string> {
  const verdict = await checkPath(path.resolve(cwd, filePath), 'read', sensitiveDirs);
  ...
  if (!isInsideDir(verdict.realPath, cwd)) {
```

Replace `isInsideCwd` with a two-argument form, keeping the old name as a
one-argument wrapper is not worth it — there is one other caller:

```ts
function isInsideDir(realPath: string, dir: string): boolean {
  const base = path.resolve(dir);
  const relative = path.relative(base, realPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
```

Apply the same `path.resolve(cwd, filePath)` to `writeFileTool`. In
`runCommandTool`, pass it to spawn:

```ts
    const child = spawn(command, { shell: true, cwd });
```

- [ ] **Step 4: Run the new test and the existing tool tests**

Run: `npx vitest run tests/tools tests/hardening.test.ts`
Expected: PASS. The hardening suite covers sensitive-path refusals and must be
unaffected — if it is not, the resolve was applied after the check instead of
before.

- [ ] **Step 5: Pass `cwd` from `runTurn`**

In `src/repl/run-turn.ts`, add to `TurnOptions`:

```ts
  /** Where tools run for this turn. Defaults to the process's directory. */
  cwd?: string;
```

and include it in the `executeTool` options object inside the `runAgentTurn`
call:

```ts
            executeTool(toolCall, confirm, {
              onAutoApproved: options.onAutoApproved,
              onOutput: options.onOutput,
              cwd: options.cwd,
              mcp: options.mcp,
              memory: options.memory,
              skills: options.skills,
            }),
```

- [ ] **Step 6: Full suite and commit**

Run: `npm run check`
Expected: all tests pass.

```bash
git add src/tools/execute.ts src/repl/run-turn.ts tests/tools/execute-cwd.test.ts
git commit -m "tools: run where the session lives, not where the process does"
```

---

### Task 4: Approval registry

**Files:**
- Create: `src/gateway/approvals.ts`
- Test: `tests/gateway/approvals.test.ts`
- Delete: `src/repl/approval-gate.ts` and `tests/repl/approval-gate.test.ts` (their policy moves here; the REPL keeps only rendering)

**Interfaces:**
- Consumes: `ConfirmFn`, `ConfirmRequest` from `src/tools/execute.js`; `ApprovalOrigin` from `src/gateway/protocol.js`.
- Produces:

```ts
export interface PendingApproval {
  id: string;
  sessionId: number;
  request: ConfirmRequest;
  origin: ApprovalOrigin;
}
export interface ApprovalRegistryDeps {
  /** Offers a pending approval to clients. Returns how many can answer it. */
  broadcast(pending: PendingApproval): number;
  /** Tells clients an approval is settled, so they close their prompt. */
  resolved(pending: PendingApproval, approved: boolean, by: string): void;
  timeoutMs?: number;
}
export class ApprovalRegistry {
  constructor(deps: ApprovalRegistryDeps);
  confirmFor(sessionId: number, origin: ApprovalOrigin, autoApprove: boolean): ConfirmFn;
  answer(approvalId: string, approved: boolean, by: string): boolean;
  beginTurn(sessionId: number): void;
  pending(): PendingApproval[];
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/approvals.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalRegistry, type PendingApproval } from '../../src/gateway/approvals';
import type { ConfirmRequest } from '../../src/tools/execute';

const terminal = { surface: 'terminal' as const };
const telegram = { surface: 'telegram', who: '@sam' };

const command = (text: string): ConfirmRequest => ({
  kind: 'run_command',
  message: `Run "${text}"?`,
});

function registry(approverCount = 1) {
  const seen: PendingApproval[] = [];
  const resolved = vi.fn();
  const reg = new ApprovalRegistry({
    broadcast: (pending) => {
      seen.push(pending);
      return approverCount;
    },
    resolved,
  });
  return { reg, seen, resolved };
}

describe('ApprovalRegistry', () => {
  it('resolves true when a client approves', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const answer = confirm(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'terminal-1');

    expect(await answer).toBe(true);
  });

  it('tells clients the approval is settled so they can close the box', async () => {
    const { reg, seen, resolved } = registry();
    const answer = reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    reg.answer(seen[0].id, true, 'terminal-1');
    await answer;

    expect(resolved).toHaveBeenCalledWith(seen[0], true, 'terminal-1');
  });

  it('ignores a second answer to a settled approval', async () => {
    const { reg, seen } = registry(2);
    const answer = reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(reg.answer(seen[0].id, true, 'terminal-1')).toBe(true);
    expect(reg.answer(seen[0].id, false, 'terminal-2')).toBe(false);
    expect(await answer).toBe(true);
  });

  // Today's `serve` behaviour, preserved: nobody at the keyboard means no.
  it('denies immediately when no client can approve', async () => {
    const { reg } = registry(0);
    expect(await reg.confirmFor(1, telegram, false)(command('rm -rf /'))).toBe(false);
  });

  it('approves without asking anyone when the session is auto-approve', async () => {
    const { reg, seen } = registry(1);
    expect(await reg.confirmFor(1, telegram, true)(command('ls'))).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('carries the origin, so the box can say where the request came from', async () => {
    const { reg, seen } = registry();
    void reg.confirmFor(3, telegram, false)(command('npm publish'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0].origin).toEqual(telegram);
    expect(seen[0].sessionId).toBe(3);
  });

  it('refuses an identical repeat without asking again', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const first = confirm(command('google dp 203'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    expect(await first).toBe(false);

    expect(await confirm(command('google dp 203'))).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('still asks about a different request after a refusal', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const first = confirm(command('google dp 203'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    await first;

    void confirm(command('google ai 102'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
  });

  it('forgets refusals when the next turn starts', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const first = confirm(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    await first;

    reg.beginTurn(1);
    void confirm(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
  });

  it('keeps one session\'s refusals out of another\'s', async () => {
    const { reg, seen } = registry();
    const one = reg.confirmFor(1, terminal, false);
    const two = reg.confirmFor(2, terminal, false);

    const first = one(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    await first;

    void two(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
  });
});

describe('ApprovalRegistry timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('denies an approval nobody answers', async () => {
    const seen: PendingApproval[] = [];
    const reg = new ApprovalRegistry({
      broadcast: (p) => {
        seen.push(p);
        return 1;
      },
      resolved: vi.fn(),
      timeoutMs: 1000,
    });

    const answer = reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.advanceTimersByTimeAsync(1001);

    expect(await answer).toBe(false);
    expect(reg.pending()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/gateway/approvals.test.ts`
Expected: FAIL — cannot resolve `src/gateway/approvals`.

- [ ] **Step 3: Write the module**

Create `src/gateway/approvals.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { ConfirmFn, ConfirmRequest } from '../tools/execute.js';
import type { ApprovalOrigin } from './protocol.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface PendingApproval {
  id: string;
  sessionId: number;
  request: ConfirmRequest;
  origin: ApprovalOrigin;
}

export interface ApprovalRegistryDeps {
  /** Offers a pending approval to clients. Returns how many can answer it. */
  broadcast(pending: PendingApproval): number;
  /** Tells clients an approval is settled, so they close their prompt. */
  resolved(pending: PendingApproval, approved: boolean, by: string): void;
  timeoutMs?: number;
}

interface Entry {
  pending: PendingApproval;
  settle: (approved: boolean, by: string) => void;
}

function requestKey(sessionId: number, request: ConfirmRequest): string {
  return `${sessionId} ${request.kind} ${request.message}`;
}

/**
 * Holds tool approvals until a human answers, or until it is clear none will.
 *
 * Refusals are remembered for the rest of the reply, and that is not symmetry
 * for its own sake. A declined tool call reads to a model as a failed attempt,
 * and the reflex after a failed attempt is another attempt: one reply put the
 * same skill proposal to the user four times and seven variants of a search
 * command. Re-asking a question already answered is not caution, it is noise,
 * and noise is what stops people reading these prompts at all.
 *
 * The memory is per session and per reply — the next thing the user types may
 * be precisely a request to do the thing they just refused.
 */
export class ApprovalRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly declined = new Map<number, Set<string>>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: ApprovalRegistryDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Clears the per-reply refusals for one session. */
  beginTurn(sessionId: number): void {
    this.declined.delete(sessionId);
  }

  pending(): PendingApproval[] {
    return [...this.entries.values()].map((entry) => entry.pending);
  }

  confirmFor(sessionId: number, origin: ApprovalOrigin, autoApprove: boolean): ConfirmFn {
    return (request) => this.ask(sessionId, origin, autoApprove, request);
  }

  answer(approvalId: string, approved: boolean, by: string): boolean {
    const entry = this.entries.get(approvalId);
    if (!entry) return false;
    entry.settle(approved, by);
    return true;
  }

  private ask(
    sessionId: number,
    origin: ApprovalOrigin,
    autoApprove: boolean,
    request: ConfirmRequest
  ): Promise<boolean> {
    // A session the operator marked auto-approve never reaches a human by
    // design. It is the old --allow-tools, now a property of the session
    // rather than of the process, so `/session` and `gateway status` can show
    // which conversations carry it.
    if (autoApprove) return Promise.resolve(true);

    const key = requestKey(sessionId, request);
    if (this.declined.get(sessionId)?.has(key)) return Promise.resolve(false);

    const pending: PendingApproval = { id: randomUUID(), sessionId, request, origin };

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean, by: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.entries.delete(pending.id);
        if (!approved) {
          const set = this.declined.get(sessionId) ?? new Set<string>();
          set.add(key);
          this.declined.set(sessionId, set);
        }
        this.deps.resolved(pending, approved, by);
        resolve(approved);
      };

      const timer = setTimeout(() => settle(false, 'timeout'), this.timeoutMs);
      // Node keeps the process alive for a pending timer. A daemon waiting on
      // an approval nobody will answer should not also be unkillable.
      timer.unref?.();

      this.entries.set(pending.id, { pending, settle });

      const approvers = this.deps.broadcast(pending);
      // Nobody at a keyboard means no. This is exactly what `robin serve`
      // does today, and it is the behaviour that makes running the bridge
      // without --allow-tools safe.
      if (approvers === 0) settle(false, 'nobody attached');
    });
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gateway/approvals.test.ts`
Expected: PASS.

- [ ] **Step 5: Delete the superseded REPL gate**

```bash
git rm src/repl/approval-gate.ts tests/repl/approval-gate.test.ts
```

`run-repl.ts` still imports it and will not compile — Task 10 rewrites that
file. To keep the tree building in the meantime, replace the import and the
`approvals` wiring in `run-repl.ts` with the pre-existing inline gate:
restore `createApprovalGate` as a local function in `run-repl.ts` exactly as it
stood before (`git show f394713^:src/repl/run-repl.ts` has it), including the
four-choice prompt. It is temporary and Task 10 deletes it.

- [ ] **Step 6: Full suite and commit**

Run: `npm run check`

```bash
git add -A src/gateway/approvals.ts tests/gateway/approvals.test.ts src/repl/run-repl.ts
git commit -m "gateway: hold approvals until a human answers, or nobody can"
```

---

### Task 5: Session service — sessions

**Files:**
- Create: `src/gateway/session-service.ts`
- Test: `tests/gateway/session-service.test.ts`

**Interfaces:**
- Consumes: `SessionList` (`src/repl/session-list.js`), `createSession` (`src/repl/session.js`), all stores, `SessionSnapshot` from protocol.
- Produces:

```ts
export interface SessionServiceDeps {
  providers: Provider[];
  approvals: ApprovalRegistry;
  emit(sessionId: number, event: GatewayEvent): void;
  stores: {
    unsupported: UnsupportedModelStore;
    contextLimits: ContextLimitStore;
    memory: MemoryStore;
    skills: SkillStore;
    conversation: ConversationStore;
  };
  mcp?: McpRegistry;
  personality?: string;
}
export class SessionService {
  constructor(deps: SessionServiceDeps);
  list(): SessionSnapshot[];
  create(params: { providerId: string; model: string; cwd: string; label?: string; autoApprove?: boolean }): SessionSnapshot;
  snapshot(id: number): SessionSnapshot;
  attach(id: number): AttachResult;
  update(id: number, patch: { providerId?: string; model?: string; systemPrompt?: string | null; toolsEnabled?: boolean; label?: string }): SessionSnapshot;
  clear(id: number): SessionSnapshot;
  close(id: number): void;
}
```

Turn execution lands in Task 6; this task is state only.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/session-service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { Provider } from '../../src/providers/types';

function fakeProvider(id: string, name: string): Provider {
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['m1']),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'ok' };
    }),
  } as unknown as Provider;
}

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

function service(emit = vi.fn()) {
  const providers = [fakeProvider('copilot', 'GitHub Copilot'), fakeProvider('ollama', 'Ollama (local)')];
  const svc = new SessionService({
    providers,
    approvals: new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() }),
    emit,
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
      memory: undefined as never,
      skills: undefined as never,
      conversation: undefined as never,
    },
  });
  return { svc, emit, providers };
}

describe('SessionService sessions', () => {
  it('starts with no sessions', () => {
    expect(service().svc.list()).toEqual([]);
  });

  it('creates a session and reports it', () => {
    const { svc } = service();
    const snapshot = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: 'C:/work' });

    expect(snapshot).toMatchObject({
      id: 1,
      providerId: 'copilot',
      providerName: 'GitHub Copilot',
      model: 'gpt-4o',
      cwd: 'C:/work',
      toolsEnabled: true,
      autoApprove: false,
      busy: false,
      queued: 0,
    });
    expect(svc.list()).toHaveLength(1);
  });

  it('rejects a provider it does not know', () => {
    const { svc } = service();
    expect(() => svc.create({ providerId: 'nope', model: 'm', cwd: '.' })).toThrow(/nope/);
  });

  it('attaches with an empty history on a fresh session', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    expect(svc.attach(created.id)).toEqual({ snapshot: created, history: [] });
  });

  it('updates the model and announces the change', () => {
    const { svc, emit } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const updated = svc.update(created.id, { model: 'gpt-5' });

    expect(updated.model).toBe('gpt-5');
    expect(emit).toHaveBeenCalledWith(
      created.id,
      expect.objectContaining({ kind: 'session.changed' })
    );
  });

  // Switching connection resets history: the model on the other side has not
  // seen any of it. Same rule the REPL has always had.
  it('clears history when the provider changes', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.appendForTest(created.id, { role: 'user', content: 'hi' });

    svc.update(created.id, { providerId: 'ollama', model: 'llama3.1' });

    expect(svc.attach(created.id).history).toEqual([]);
  });

  it('clears history on request without changing the model', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.appendForTest(created.id, { role: 'user', content: 'hi' });

    const cleared = svc.clear(created.id);

    expect(cleared.model).toBe('gpt-4o');
    expect(svc.attach(created.id).history).toEqual([]);
  });

  it('sets and clears the system prompt', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    expect(svc.update(created.id, { systemPrompt: 'be terse' }).systemPrompt).toBe('be terse');
    expect(svc.update(created.id, { systemPrompt: null }).systemPrompt).toBeUndefined();
  });

  it('closes a session', () => {
    const { svc } = service();
    const a = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    const b = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.close(a.id);

    expect(svc.list().map((s) => s.id)).toEqual([b.id]);
  });

  it('reports a missing session by id rather than throwing something opaque', () => {
    const { svc } = service();
    expect(() => svc.attach(42)).toThrow(/42/);
  });
});
```

`appendForTest` is a deliberate test seam: history is otherwise only written by
turns, and Task 6 has not been built yet. Implement it as a documented
test-only method.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/gateway/session-service.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the module (state half)**

Create `src/gateway/session-service.ts`:

```ts
import type { Message, Provider } from '../providers/types.js';
import type { GatewayEvent, SessionSnapshot, AttachResult } from './protocol.js';
import type { ApprovalRegistry } from './approvals.js';
import { createSession, type Session } from '../repl/session.js';
import type { UnsupportedModelStore } from '../providers/unsupported-models.js';
import type { ContextLimitStore } from '../providers/context-limits.js';
import type { MemoryStore } from '../memory/store.js';
import type { SkillStore } from '../skills/store.js';
import type { ConversationStore } from '../conversation-store.js';

export interface SessionServiceDeps {
  providers: Provider[];
  approvals: ApprovalRegistry;
  emit(sessionId: number, event: GatewayEvent): void;
  stores: {
    unsupported: UnsupportedModelStore;
    contextLimits: ContextLimitStore;
    memory: MemoryStore;
    skills: SkillStore;
    conversation: ConversationStore;
  };
  personality?: string;
}

/** A session plus what the daemon needs that a REPL session never carried. */
interface Record_ {
  session: Session;
  cwd: string;
  autoApprove: boolean;
  /** Turns waiting or running. The tail is what a new prompt queues behind. */
  queue: Promise<void>;
  queued: number;
  busy: boolean;
}

/**
 * Owns every open conversation and the stores behind them.
 *
 * Deliberately socket-free: this is where the daemon's behaviour lives, and it
 * is testable by calling methods. `server.ts` translates frames into these
 * calls and nothing else.
 */
export class SessionService {
  private readonly records = new Map<number, Record_>();
  private nextId = 1;

  constructor(private readonly deps: SessionServiceDeps) {}

  list(): SessionSnapshot[] {
    return [...this.records.keys()].sort((a, b) => a - b).map((id) => this.snapshot(id));
  }

  create(params: {
    providerId: string;
    model: string;
    cwd: string;
    label?: string;
    autoApprove?: boolean;
  }): SessionSnapshot {
    const provider = this.provider(params.providerId);
    const id = this.nextId++;
    const session = createSession(provider, params.model, id);
    session.label = params.label;
    session.personality = this.deps.personality;
    this.records.set(id, {
      session,
      cwd: params.cwd,
      autoApprove: params.autoApprove ?? false,
      queue: Promise.resolve(),
      queued: 0,
      busy: false,
    });
    return this.snapshot(id);
  }

  attach(id: number): AttachResult {
    return { snapshot: this.snapshot(id), history: [...this.record(id).session.history] };
  }

  update(
    id: number,
    patch: {
      providerId?: string;
      model?: string;
      systemPrompt?: string | null;
      toolsEnabled?: boolean;
      label?: string;
    }
  ): SessionSnapshot {
    const record = this.record(id);
    const { session } = record;

    // A connection switch resets the conversation: the model on the other side
    // has not seen any of it, and replaying it would present someone else's
    // conversation as its own.
    const switchingConnection =
      (patch.providerId !== undefined && patch.providerId !== session.provider.id) ||
      (patch.model !== undefined && patch.model !== session.model);

    if (patch.providerId !== undefined) session.provider = this.provider(patch.providerId);
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.toolsEnabled !== undefined) session.toolsEnabled = patch.toolsEnabled;
    if (patch.label !== undefined) session.label = patch.label;
    if (patch.systemPrompt !== undefined) {
      session.systemPrompt = patch.systemPrompt ?? undefined;
    }
    if (switchingConnection) {
      session.history = [];
      session.chatLog.startNewSession();
    }

    const snapshot = this.snapshot(id);
    this.deps.emit(id, { kind: 'session.changed', snapshot });
    return snapshot;
  }

  clear(id: number): SessionSnapshot {
    const { session } = this.record(id);
    session.history = [];
    session.turnCount = 0;
    session.chatLog.startNewSession();
    const snapshot = this.snapshot(id);
    this.deps.emit(id, { kind: 'session.changed', snapshot });
    return snapshot;
  }

  close(id: number): void {
    this.record(id);
    this.records.delete(id);
  }

  snapshot(id: number): SessionSnapshot {
    const record = this.record(id);
    const { session } = record;
    return {
      id,
      label: session.label,
      providerId: session.provider.id,
      providerName: session.provider.name,
      model: session.model,
      cwd: record.cwd,
      toolsEnabled: session.toolsEnabled,
      autoApprove: record.autoApprove,
      turnCount: session.turnCount,
      systemPrompt: session.systemPrompt,
      busy: record.busy,
      queued: record.queued,
    };
  }

  /** Test-only seam: history is otherwise written only by a turn. */
  appendForTest(id: number, message: Message): void {
    this.record(id).session.history.push(message);
  }

  private record(id: number): Record_ {
    const record = this.records.get(id);
    if (!record) throw new Error(`No session ${id}.`);
    return record;
  }

  private provider(id: string): Provider {
    const provider = this.deps.providers.find((p) => p.id === id);
    if (!provider) throw new Error(`Unknown provider "${id}".`);
    return provider;
  }
}
```

Note: `SessionList` is not used. Its id allocation and "never fewer than one
session" rules were REPL rules — the daemon may legitimately hold zero
sessions, and ids no longer need to stay single-digit because nobody types
them at a `/session` prompt without seeing the list first. Leave
`src/repl/session-list.ts` in place; Task 11 decides its fate.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gateway/session-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.test.json
git add src/gateway/session-service.ts tests/gateway/session-service.test.ts
git commit -m "gateway: one owner for every open conversation"
```

---

### Task 6: Session service — turns

**Files:**
- Modify: `src/gateway/session-service.ts`
- Test: `tests/gateway/session-service-turns.test.ts`

**Interfaces:**
- Consumes: `runTurn` from `src/repl/run-turn.js`.
- Produces on `SessionService`:

```ts
sendPrompt(id: number, text: string, origin: ApprovalOrigin): PromptAccepted;
interrupt(turnId: string): boolean;
/** Resolves when every queued turn has finished. Test and shutdown use only. */
idle(): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/session-service-turns.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { GatewayEvent } from '../../src/gateway/protocol';
import type { Provider } from '../../src/providers/types';

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

/** Yields the given text one chunk at a time. */
function textProvider(chunks: string[]): Provider {
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['gpt-4o']),
    chat: vi.fn().mockImplementation(async function* () {
      for (const chunk of chunks) yield { type: 'text', text: chunk };
    }),
  } as unknown as Provider;
}

function service(provider: Provider) {
  const events: { sessionId: number; event: GatewayEvent }[] = [];
  const svc = new SessionService({
    providers: [provider],
    approvals: new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() }),
    emit: (sessionId, event) => events.push({ sessionId, event }),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
      memory: undefined as never,
      skills: undefined as never,
      conversation: undefined as never,
    },
  });
  return { svc, events };
}

const terminal = { surface: 'terminal' };
const kinds = (events: { event: GatewayEvent }[]) => events.map((e) => e.event.kind);

describe('SessionService turns', () => {
  it('accepts a prompt immediately and streams the reply as events', async () => {
    const { svc, events } = service(textProvider(['Hello ', 'there']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const accepted = svc.sendPrompt(session.id, 'hi', terminal);
    expect(accepted.queuePosition).toBe(0);
    expect(accepted.turnId).toMatch(/\S/);

    await svc.idle();

    expect(kinds(events)).toEqual([
      'turn.started',
      'text',
      'text',
      'turn.finished',
    ]);
    const deltas = events
      .filter((e) => e.event.kind === 'text')
      .map((e) => (e.event as { delta: string }).delta);
    expect(deltas.join('')).toBe('Hello there');
  });

  it('keeps the conversation, so attach shows it afterwards', async () => {
    const { svc } = service(textProvider(['answered']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    expect(svc.attach(session.id).history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answered' },
    ]);
  });

  it('runs one turn at a time and reports the queue position', async () => {
    const { svc } = service(textProvider(['a']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const first = svc.sendPrompt(session.id, 'one', terminal);
    const second = svc.sendPrompt(session.id, 'two', terminal);
    const third = svc.sendPrompt(session.id, 'three', terminal);

    expect(first.queuePosition).toBe(0);
    expect(second.queuePosition).toBe(1);
    expect(third.queuePosition).toBe(2);

    await svc.idle();

    // Serialised, not interleaved: three user messages and three replies, in
    // the order they were sent.
    const history = svc.attach(session.id).history;
    expect(history.map((m) => m.content)).toEqual(['one', 'a', 'two', 'a', 'three', 'a']);
  });

  it('reports busy in the snapshot while a turn runs', async () => {
    const { svc } = service(textProvider(['a']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    expect(svc.snapshot(session.id).busy).toBe(true);

    await svc.idle();
    expect(svc.snapshot(session.id).busy).toBe(false);
  });

  it('reports a failed turn through turn.finished rather than throwing', async () => {
    const failing = {
      ...textProvider([]),
      chat: vi.fn().mockImplementation(async function* () {
        throw new Error('boom');
      }),
    } as unknown as Provider;
    const { svc, events } = service(failing);
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    const finished = events.at(-1)?.event as { kind: string; ok: boolean; error?: string };
    expect(finished.kind).toBe('turn.finished');
    expect(finished.ok).toBe(false);
    expect(finished.error).toContain('boom');
  });

  it('interrupts the turn it is given', async () => {
    const slow = {
      ...textProvider([]),
      chat: vi.fn().mockImplementation(async function* (
        _m: string,
        _h: unknown,
        _t: unknown,
        signal?: AbortSignal
      ) {
        yield { type: 'text', text: 'partial' };
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        yield { type: 'text', text: ' and the rest' };
      }),
    } as unknown as Provider;
    const { svc, events } = service(slow);
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const accepted = svc.sendPrompt(session.id, 'hi', terminal);
    expect(svc.interrupt(accepted.turnId)).toBe(true);
    await svc.idle();

    const finished = events.at(-1)?.event as { kind: string; aborted: boolean };
    expect(finished.kind).toBe('turn.finished');
    expect(finished.aborted).toBe(true);
  });

  it('starts each turn with a clean approval slate', async () => {
    const beginTurn = vi.fn();
    const approvals = new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() });
    approvals.beginTurn = beginTurn;
    const svc = new SessionService({
      providers: [textProvider(['a'])],
      approvals,
      emit: vi.fn(),
      stores: {
        unsupported: new UnsupportedModelStore(throwaway('unsupported')),
        contextLimits: new ContextLimitStore(throwaway('limits')),
        memory: undefined as never,
        skills: undefined as never,
        conversation: undefined as never,
      },
    });
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    expect(beginTurn).toHaveBeenCalledWith(session.id);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/gateway/session-service-turns.test.ts`
Expected: FAIL — `sendPrompt` is not a function.

- [ ] **Step 3: Add turn execution**

Add to `src/gateway/session-service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { runTurn } from '../repl/run-turn.js';
import type { ApprovalOrigin, PromptAccepted } from './protocol.js';
```

and to the class:

```ts
  private readonly running = new Map<string, AbortController>();

  /**
   * Queues a prompt and returns immediately.
   *
   * The queue is per session and the reason is not politeness: two messages
   * arriving during a turn would otherwise both mutate one history array and
   * interleave into nonsense. `bridge.ts` has always done this per chat; here
   * it covers every surface at once, which is the point of a shared session.
   */
  sendPrompt(id: number, text: string, origin: ApprovalOrigin): PromptAccepted {
    const record = this.record(id);
    const turnId = randomUUID();
    const queuePosition = record.queued;
    record.queued += 1;

    record.queue = record.queue
      .catch(() => {})
      .then(() => this.runOne(id, turnId, text, origin));

    return { turnId, queuePosition };
  }

  interrupt(turnId: string): boolean {
    const controller = this.running.get(turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Resolves once nothing is queued. For shutdown and for tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.records.values()].map((record) => record.queue.catch(() => {})));
  }

  private async runOne(
    id: number,
    turnId: string,
    text: string,
    origin: ApprovalOrigin
  ): Promise<void> {
    const record = this.records.get(id);
    // The session may have been closed while this sat in the queue.
    if (!record) return;

    const { session } = record;
    const controller = new AbortController();
    this.running.set(turnId, controller);
    record.busy = true;
    record.queued = Math.max(0, record.queued - 1);

    this.deps.emit(id, {
      kind: 'turn.started',
      turnId,
      providerName: session.provider.name,
      model: session.model,
    });
    this.deps.approvals.beginTurn(id);

    try {
      const result = await runTurn(session, text, {
        signal: controller.signal,
        cwd: record.cwd,
        confirm: this.deps.approvals.confirmFor(id, origin, record.autoApprove),
        unsupportedStore: this.deps.stores.unsupported,
        contextLimits: this.deps.stores.contextLimits,
        memory: this.deps.stores.memory,
        skills: this.deps.stores.skills,
        onText: (delta) => this.deps.emit(id, { kind: 'text', turnId, delta }),
        onThinking: (delta) => this.deps.emit(id, { kind: 'thinking', turnId, delta }),
        onAutoApproved: (command) =>
          this.deps.emit(id, { kind: 'tool.auto_approved', turnId, command }),
        onOutput: (chunk) => this.deps.emit(id, { kind: 'tool.output', turnId, chunk }),
        onTrim: ({ dropped, limit }) =>
          this.deps.emit(id, { kind: 'trim', turnId, dropped, limit }),
        onFallback: ({ error, next }) =>
          this.deps.emit(id, {
            kind: 'fallback',
            turnId,
            message: error.message,
            providerName: next.provider.name,
            model: next.model,
          }),
      });

      if (result.provider.id !== session.provider.id || result.model !== session.model) {
        // Fallback rescued the turn on another model. The session follows it,
        // exactly as the REPL has always done, and every attached client is
        // told so their status line is not a lie.
        session.provider = result.provider;
        session.model = result.model;
        this.deps.emit(id, { kind: 'session.changed', snapshot: this.snapshot(id) });
      }

      await session.chatLog.write(session.provider.name, session.model, session.history);

      this.deps.emit(id, {
        kind: 'turn.finished',
        turnId,
        ok: result.ok,
        aborted: result.aborted ?? false,
        providerName: result.provider.name,
        model: result.model,
        error: result.error?.message,
      });
    } catch (err) {
      // runTurn reports failure in its result rather than throwing, so this is
      // a bug or a store failure. It must still close the turn out — a client
      // waiting on turn.finished would otherwise wait forever.
      this.deps.emit(id, {
        kind: 'turn.finished',
        turnId,
        ok: false,
        aborted: false,
        providerName: session.provider.name,
        model: session.model,
        error: (err as Error).message,
      });
    } finally {
      this.running.delete(turnId);
      record.busy = false;
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/gateway/`
Expected: PASS, including Task 5's tests unchanged.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/gateway/session-service.ts tests/gateway/session-service-turns.test.ts
git commit -m "gateway: run turns, one at a time, and say what happened"
```

---

### Task 7: WebSocket server

**Files:**
- Create: `src/gateway/server.ts`
- Test: `tests/gateway/server.test.ts`

**Interfaces:**
- Consumes: `SessionService`, `ApprovalRegistry`, protocol types, `ws`.
- Produces:

```ts
export interface GatewayServerDeps {
  sessions: SessionService;
  approvals: ApprovalRegistry;
  token: string;
  port: number;
  log?: (line: string) => void;
}
export class GatewayServer {
  constructor(deps: GatewayServerDeps);
  listen(): Promise<number>;   // resolves with the bound port
  close(): Promise<void>;
  /** Wired into SessionService.emit and ApprovalRegistry.broadcast. */
  emit(sessionId: number, event: GatewayEvent): void;
  broadcastApproval(pending: PendingApproval): number;
  resolvedApproval(pending: PendingApproval, approved: boolean, by: string): void;
}
```

Wiring note: `GatewayServer`, `SessionService` and `ApprovalRegistry` are
mutually referential. Construct the server first with `sessions` assigned after
via a setter, or — preferred — build them in `startGateway()` (Task 9) with
closures: `new ApprovalRegistry({ broadcast: (p) => server.broadcastApproval(p), ... })`
where `server` is declared with `let` above. Keep the cycle in one factory
function so no module has to know about it.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { GatewayServer } from '../../src/gateway/server';
import { PROTOCOL_VERSION, parseFrame, type Frame } from '../../src/gateway/protocol';

/** Minimal hand-rolled client — the real one arrives in Task 8. */
function open(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function next(socket: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      const frame = parseFrame(String(data));
      if (frame) resolve(frame);
      else reject(new Error(`unparseable: ${String(data)}`));
    });
  });
}

function send(socket: WebSocket, frame: unknown): void {
  socket.send(JSON.stringify(frame));
}

const connectParams = {
  token: 'right-token',
  kind: 'terminal',
  canApprove: true,
  cwd: '.',
  protocol: PROTOCOL_VERSION,
};

let server: GatewayServer;
let port: number;
const sessions = {
  list: vi.fn().mockReturnValue([]),
  create: vi.fn(),
  attach: vi.fn(),
  update: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
  snapshot: vi.fn(),
  sendPrompt: vi.fn(),
  interrupt: vi.fn(),
};
const approvals = { answer: vi.fn().mockReturnValue(true) };

beforeEach(async () => {
  vi.clearAllMocks();
  sessions.list.mockReturnValue([]);
  server = new GatewayServer({
    sessions: sessions as never,
    approvals: approvals as never,
    token: 'right-token',
    port: 0, // ephemeral: a fixed port makes tests fight each other
    log: () => {},
  });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
});

describe('GatewayServer handshake', () => {
  it('answers a good connect with the session list', async () => {
    const socket = await open(port);
    send(socket, { type: 'req', id: '1', method: 'connect', params: connectParams });

    const frame = await next(socket);
    expect(frame).toMatchObject({ type: 'res', id: '1', ok: true });
    expect((frame as { result: { sessions: unknown[] } }).result.sessions).toEqual([]);
    socket.close();
  });

  it('refuses a wrong token and closes the socket', async () => {
    const socket = await open(port);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    send(socket, {
      type: 'req',
      id: '1',
      method: 'connect',
      params: { ...connectParams, token: 'wrong' },
    });

    const frame = await next(socket);
    expect(frame).toMatchObject({ type: 'res', ok: false });
    expect((frame as { error: { code: string } }).error.code).toBe('unauthorized');
    await closed;
  });

  // Auto-start means a stale daemon outlives a rebuild. This is the message
  // that turns a baffling failure into an obvious one.
  it('refuses a protocol version it does not speak, naming the fix', async () => {
    const socket = await open(port);
    send(socket, {
      type: 'req',
      id: '1',
      method: 'connect',
      params: { ...connectParams, protocol: PROTOCOL_VERSION + 1 },
    });

    const frame = await next(socket);
    expect(frame).toMatchObject({ type: 'res', ok: false });
    const error = (frame as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('protocol-mismatch');
    expect(error.message).toContain('robin gateway stop');
    socket.close();
  });

  it('refuses any method before connect', async () => {
    const socket = await open(port);
    send(socket, { type: 'req', id: '1', method: 'session.list', params: {} });

    const frame = await next(socket);
    expect(frame).toMatchObject({ type: 'res', ok: false });
    expect((frame as { error: { code: string } }).error.code).toBe('not-connected');
    socket.close();
  });
});

describe('GatewayServer methods', () => {
  async function connected(canApprove = true): Promise<WebSocket> {
    const socket = await open(port);
    send(socket, {
      type: 'req',
      id: 'c',
      method: 'connect',
      params: { ...connectParams, canApprove },
    });
    await next(socket);
    return socket;
  }

  it('routes a call through to the session service', async () => {
    sessions.create.mockReturnValue({ id: 7 });
    const socket = await connected();

    send(socket, {
      type: 'req',
      id: '2',
      method: 'session.create',
      params: { providerId: 'copilot', model: 'gpt-4o', cwd: 'C:/work' },
    });
    const frame = await next(socket);

    expect(sessions.create).toHaveBeenCalledWith({
      providerId: 'copilot',
      model: 'gpt-4o',
      cwd: 'C:/work',
    });
    expect(frame).toMatchObject({ type: 'res', id: '2', ok: true, result: { id: 7 } });
    socket.close();
  });

  it('turns a thrown error into a failed response, not a dropped socket', async () => {
    sessions.attach.mockImplementation(() => {
      throw new Error('No session 42.');
    });
    const socket = await connected();

    send(socket, { type: 'req', id: '3', method: 'session.attach', params: { id: 42 } });
    const frame = await next(socket);

    expect(frame).toMatchObject({ type: 'res', ok: false });
    expect((frame as { error: { message: string } }).error.message).toContain('42');
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('rejects an unknown method', async () => {
    const socket = await connected();
    send(socket, { type: 'req', id: '4', method: 'nonsense', params: {} });

    const frame = await next(socket);
    expect((frame as { error: { code: string } }).error.code).toBe('unknown-method');
    socket.close();
  });
});

describe('GatewayServer events', () => {
  async function connectedAndAttached(id: number): Promise<WebSocket> {
    sessions.attach.mockReturnValue({ snapshot: { id }, history: [] });
    const socket = await open(port);
    send(socket, { type: 'req', id: 'c', method: 'connect', params: connectParams });
    await next(socket);
    send(socket, { type: 'req', id: 'a', method: 'session.attach', params: { id } });
    await next(socket);
    return socket;
  }

  it('delivers a session event to clients attached to that session', async () => {
    const socket = await connectedAndAttached(1);
    const received = next(socket);

    server.emit(1, { kind: 'text', turnId: 't', delta: 'hello' });

    expect(await received).toMatchObject({
      type: 'event',
      sessionId: 1,
      event: { kind: 'text', delta: 'hello' },
    });
    socket.close();
  });

  it('does not deliver another session\'s events', async () => {
    const socket = await connectedAndAttached(1);
    const seen: Frame[] = [];
    socket.on('message', (data) => {
      const frame = parseFrame(String(data));
      if (frame) seen.push(frame);
    });

    server.emit(2, { kind: 'text', turnId: 't', delta: 'not yours' });
    server.emit(1, { kind: 'text', turnId: 't', delta: 'yours' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]).toMatchObject({ sessionId: 1 });
    socket.close();
  });

  it('counts only clients that can approve when broadcasting an approval', async () => {
    const approver = await connectedAndAttached(1);
    const bystander = await open(port);
    send(bystander, {
      type: 'req',
      id: 'c',
      method: 'connect',
      params: { ...connectParams, canApprove: false },
    });
    await next(bystander);

    const count = server.broadcastApproval({
      id: 'ap-1',
      sessionId: 1,
      request: { kind: 'run_command', message: 'Run "ls"?' },
      origin: { surface: 'telegram', who: '@sam' },
    });

    expect(count).toBe(1);
    approver.close();
    bystander.close();
  });

  it('routes approval.answer to the registry', async () => {
    const socket = await connectedAndAttached(1);
    send(socket, {
      type: 'req',
      id: '5',
      method: 'approval.answer',
      params: { approvalId: 'ap-1', approved: true },
    });
    await next(socket);

    expect(approvals.answer).toHaveBeenCalledWith('ap-1', true, expect.any(String));
    socket.close();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/gateway/server.test.ts`
Expected: FAIL — cannot resolve `src/gateway/server`.

- [ ] **Step 3: Write the module**

Create `src/gateway/server.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseFrame,
  type ClientKind,
  type EventFrame,
  type GatewayEvent,
  type RequestFrame,
  type ResponseFrame,
} from './protocol.js';
import type { SessionService } from './session-service.js';
import type { ApprovalRegistry, PendingApproval } from './approvals.js';

export interface GatewayServerDeps {
  sessions: SessionService;
  approvals: ApprovalRegistry;
  token: string;
  port: number;
  log?: (line: string) => void;
}

interface Client {
  id: string;
  socket: WebSocket;
  connected: boolean;
  kind: ClientKind;
  canApprove: boolean;
  cwd: string;
  attached: Set<number>;
}

/**
 * The socket half. Translates frames into SessionService calls and events into
 * frames, and does nothing else — every decision worth testing lives behind it
 * in session-service.ts and approvals.ts.
 */
export class GatewayServer {
  private wss: WebSocketServer | undefined;
  private readonly clients = new Map<string, Client>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: GatewayServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Loopback only. This socket can run commands as the user who started
      // it; the token is a second lock, not the first one.
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.deps.port });
      this.wss = wss;
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.removeListener('error', reject);
        const address = wss.address();
        resolve(typeof address === 'object' && address ? address.port : this.deps.port);
      });
      wss.on('connection', (socket) => this.accept(socket));
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.socket.close();
    this.clients.clear();
    const wss = this.wss;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.wss = undefined;
  }

  emit(sessionId: number, event: GatewayEvent): void {
    const frame: EventFrame = { type: 'event', sessionId, event };
    for (const client of this.clients.values()) {
      if (client.connected && client.attached.has(sessionId)) this.write(client, frame);
    }
  }

  /** Offers an approval to every client that can answer one. */
  broadcastApproval(pending: PendingApproval): number {
    let offered = 0;
    for (const client of this.clients.values()) {
      if (!client.connected || !client.canApprove) continue;
      this.write(client, {
        type: 'event',
        sessionId: pending.sessionId,
        event: {
          kind: 'approval.request',
          approvalId: pending.id,
          request: pending.request,
          origin: pending.origin,
        },
      });
      offered += 1;
    }
    return offered;
  }

  resolvedApproval(pending: PendingApproval, approved: boolean, by: string): void {
    for (const client of this.clients.values()) {
      if (!client.connected || !client.canApprove) continue;
      this.write(client, {
        type: 'event',
        sessionId: pending.sessionId,
        event: { kind: 'approval.resolved', approvalId: pending.id, approved, by },
      });
    }
  }

  private accept(socket: WebSocket): void {
    const client: Client = {
      id: randomUUID(),
      socket,
      connected: false,
      kind: 'terminal',
      canApprove: false,
      cwd: process.cwd(),
      attached: new Set(),
    };
    this.clients.set(client.id, client);

    socket.on('message', (data) => {
      const frame = parseFrame(String(data));
      // Anything can be on the other end of a socket. A frame that does not
      // parse is not a conversation worth continuing.
      if (!frame || frame.type !== 'req') {
        socket.close();
        return;
      }
      void this.dispatch(client, frame);
    });

    socket.on('close', () => {
      this.clients.delete(client.id);
    });
  }

  private async dispatch(client: Client, frame: RequestFrame): Promise<void> {
    try {
      const result = await this.handle(client, frame);
      this.write(client, { type: 'res', id: frame.id, ok: true, result });
    } catch (err) {
      const error = err as Error & { code?: string };
      this.write(client, {
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: error.code ?? 'error', message: error.message },
      });
      if (error.code === 'unauthorized' || error.code === 'protocol-mismatch') {
        client.socket.close();
      }
    }
  }

  private async handle(client: Client, frame: RequestFrame): Promise<unknown> {
    const params = frame.params;

    if (frame.method === 'connect') {
      if (params.token !== this.deps.token) throw coded('unauthorized', 'Bad gateway token.');
      if (params.protocol !== PROTOCOL_VERSION) {
        throw coded(
          'protocol-mismatch',
          `This gateway speaks protocol ${PROTOCOL_VERSION}, the client speaks ${String(params.protocol)}. ` +
            'Run `robin gateway stop` and try again — an old daemon is still running.'
        );
      }
      client.connected = true;
      client.kind = params.kind === 'channel' ? 'channel' : 'terminal';
      client.canApprove = params.canApprove === true;
      if (typeof params.cwd === 'string') client.cwd = params.cwd;
      return { sessions: this.deps.sessions.list(), protocol: PROTOCOL_VERSION };
    }

    if (!client.connected) throw coded('not-connected', 'Send connect first.');

    switch (frame.method) {
      case 'session.list':
        return { sessions: this.deps.sessions.list() };
      case 'session.create':
        return this.deps.sessions.create(params as never);
      case 'session.attach': {
        const result = this.deps.sessions.attach(Number(params.id));
        client.attached.add(Number(params.id));
        return result;
      }
      case 'session.close':
        client.attached.delete(Number(params.id));
        this.deps.sessions.close(Number(params.id));
        return {};
      case 'session.update':
        return this.deps.sessions.update(Number(params.id), params.patch as never);
      case 'session.clear':
        return this.deps.sessions.clear(Number(params.id));
      case 'prompt.send':
        return this.deps.sessions.sendPrompt(Number(params.id), String(params.text), {
          surface: client.kind === 'channel' ? String(params.surface ?? 'channel') : 'terminal',
          who: typeof params.who === 'string' ? params.who : undefined,
        });
      case 'turn.interrupt':
        return { interrupted: this.deps.sessions.interrupt(String(params.turnId)) };
      case 'approval.answer':
        return {
          accepted: this.deps.approvals.answer(
            String(params.approvalId),
            params.approved === true,
            client.id
          ),
        };
      default:
        throw coded('unknown-method', `Unknown method "${frame.method}".`);
    }
  }

  private write(client: Client, frame: ResponseFrame | EventFrame): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.socket.send(JSON.stringify(frame));
  }
}

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gateway/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/gateway/server.ts tests/gateway/server.test.ts
git commit -m "gateway: the socket, and nothing but the socket"
```

---

### Task 8: Gateway client

**Files:**
- Create: `src/gateway/client.ts`
- Test: `tests/gateway/client.test.ts`

**Interfaces:**
- Produces:

```ts
export interface GatewayClientOptions {
  port: number;
  token: string;
  kind: ClientKind;
  canApprove: boolean;
  cwd: string;
}
export class GatewayClient {
  static connect(options: GatewayClientOptions): Promise<GatewayClient>;
  readonly sessions: SessionSnapshot[];          // from hello-ok
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(handler: (sessionId: number | undefined, event: GatewayEvent) => void): () => void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/client.test.ts`. It runs against the real
`GatewayServer` from Task 7 — a fake duplex would not catch framing or auth
mistakes, which are exactly the mistakes worth catching here.

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';
import { GatewayClient } from '../../src/gateway/client';
import type { GatewayEvent } from '../../src/gateway/protocol';

const sessions = {
  list: vi.fn().mockReturnValue([{ id: 1, model: 'gpt-4o' }]),
  attach: vi.fn().mockReturnValue({ snapshot: { id: 1 }, history: [] }),
  sendPrompt: vi.fn().mockReturnValue({ turnId: 't1', queuePosition: 0 }),
  create: vi.fn(),
  update: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
  snapshot: vi.fn(),
  interrupt: vi.fn(),
};
const approvals = { answer: vi.fn().mockReturnValue(true) };

let server: GatewayServer;
let port: number;

beforeEach(async () => {
  vi.clearAllMocks();
  sessions.list.mockReturnValue([{ id: 1, model: 'gpt-4o' }]);
  sessions.attach.mockReturnValue({ snapshot: { id: 1 }, history: [] });
  sessions.sendPrompt.mockReturnValue({ turnId: 't1', queuePosition: 0 });
  server = new GatewayServer({
    sessions: sessions as never,
    approvals: approvals as never,
    token: 'tok',
    port: 0,
    log: () => {},
  });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
});

function connect(canApprove = true): Promise<GatewayClient> {
  return GatewayClient.connect({ port, token: 'tok', kind: 'terminal', canApprove, cwd: '.' });
}

describe('GatewayClient', () => {
  it('connects and reports the sessions the gateway already has', async () => {
    const client = await connect();
    expect(client.sessions).toEqual([{ id: 1, model: 'gpt-4o' }]);
    await client.close();
  });

  it('fails to connect with a bad token', async () => {
    await expect(
      GatewayClient.connect({ port, token: 'wrong', kind: 'terminal', canApprove: true, cwd: '.' })
    ).rejects.toThrow(/token/i);
  });

  it('matches responses to their requests', async () => {
    const client = await connect();
    const result = await client.request<{ turnId: string }>('prompt.send', { id: 1, text: 'hi' });
    expect(result.turnId).toBe('t1');
    await client.close();
  });

  it('rejects the request that failed, not the connection', async () => {
    sessions.attach.mockImplementation(() => {
      throw new Error('No session 42.');
    });
    const client = await connect();

    await expect(client.request('session.attach', { id: 42 })).rejects.toThrow('No session 42.');
    // Still usable afterwards.
    sessions.list.mockReturnValue([]);
    await expect(client.request('session.list')).resolves.toBeDefined();
    await client.close();
  });

  it('delivers events to a handler', async () => {
    const client = await connect();
    await client.request('session.attach', { id: 1 });
    const seen: GatewayEvent[] = [];
    client.on((_sessionId, event) => seen.push(event));

    server.emit(1, { kind: 'text', turnId: 't1', delta: 'hello' });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ kind: 'text', delta: 'hello' });
    await client.close();
  });

  it('stops delivering to an unsubscribed handler', async () => {
    const client = await connect();
    await client.request('session.attach', { id: 1 });
    const seen: GatewayEvent[] = [];
    const off = client.on((_s, event) => seen.push(event));
    off();

    server.emit(1, { kind: 'text', turnId: 't1', delta: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen).toEqual([]);
    await client.close();
  });

  it('tells the caller when the gateway goes away mid-session', async () => {
    const client = await connect();
    const closed = vi.fn();
    client.onClose(closed);

    await server.close();

    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  });

  it('rejects in-flight requests when the socket closes rather than hanging', async () => {
    const client = await connect();
    sessions.list.mockImplementation(() => {
      // Never responds: the server is torn down while this is in flight.
      return new Promise(() => {}) as never;
    });

    const inflight = client.request('session.list');
    await server.close();

    await expect(inflight).rejects.toThrow(/gateway/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/gateway/client.test.ts`
Expected: FAIL — cannot resolve `src/gateway/client`.

- [ ] **Step 3: Write the module**

Create `src/gateway/client.ts`:

```ts
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  parseFrame,
  type ClientKind,
  type GatewayEvent,
  type SessionSnapshot,
} from './protocol.js';

export interface GatewayClientOptions {
  port: number;
  token: string;
  kind: ClientKind;
  /** Whether this client can put an approval in front of a human. */
  canApprove: boolean;
  cwd: string;
}

type EventHandler = (sessionId: number | undefined, event: GatewayEvent) => void;

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * A connection to the gateway.
 *
 * Requests are matched to responses by id, because events and responses share
 * one socket and arrive interleaved — a turn's text streams in while a
 * `session.update` is still outstanding.
 */
export class GatewayClient {
  private readonly waiting = new Map<string, Waiting>();
  private readonly handlers = new Set<EventHandler>();
  private closeHandlers: (() => void)[] = [];
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly sessions: SessionSnapshot[]
  ) {
    socket.on('message', (data) => this.receive(String(data)));
    socket.on('close', () => this.onSocketClosed());
    // An error is always followed by a close; letting it reach the process as
    // an unhandled 'error' event would take the REPL down instead.
    socket.on('error', () => {});
  }

  static async connect(options: GatewayClientOptions): Promise<GatewayClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${options.port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', (err: Error) =>
        reject(new Error(`Could not reach the gateway on port ${options.port}: ${err.message}`))
      );
    });

    const id = randomUUID();
    const hello = await new Promise<{ sessions: SessionSnapshot[] }>((resolve, reject) => {
      socket.once('message', (data) => {
        const frame = parseFrame(String(data));
        if (!frame || frame.type !== 'res' || frame.id !== id) {
          reject(new Error('The gateway answered the handshake with something unexpected.'));
          return;
        }
        if (!frame.ok) {
          reject(new Error(frame.error.message));
          return;
        }
        resolve(frame.result as { sessions: SessionSnapshot[] });
      });
      socket.send(
        JSON.stringify({
          type: 'req',
          id,
          method: 'connect',
          params: {
            token: options.token,
            kind: options.kind,
            canApprove: options.canApprove,
            cwd: options.cwd,
            protocol: PROTOCOL_VERSION,
          },
        })
      );
    }).catch(async (err: Error) => {
      socket.close();
      throw err;
    });

    return new GatewayClient(socket, hello.sessions);
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The gateway connection is closed.'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  /** Subscribes to events. Returns the unsubscribe. */
  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }

  private receive(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) return;
    if (frame.type === 'event') {
      for (const handler of this.handlers) handler(frame.sessionId, frame.event);
      return;
    }
    if (frame.type !== 'res') return;
    const waiting = this.waiting.get(frame.id);
    if (!waiting) return;
    this.waiting.delete(frame.id);
    if (frame.ok) waiting.resolve(frame.result);
    else waiting.reject(new Error(frame.error.message));
  }

  private onSocketClosed(): void {
    this.closed = true;
    // A request with nobody left to answer it must fail, not hang. A REPL
    // awaiting `session.update` would otherwise sit at a dead prompt.
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    for (const waiting of pending) {
      waiting.reject(new Error('The gateway connection closed before this finished.'));
    }
    for (const handler of this.closeHandlers) handler();
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gateway/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/gateway/client.ts tests/gateway/client.test.ts
git commit -m "gateway: a client that matches answers to questions"
```

---

### Task 9: Starting, stopping and finding the daemon

**Files:**
- Create: `src/gateway/start.ts` (the factory that wires the cycle)
- Create: `src/gateway/ensure.ts`
- Create: `src/commands/gateway-command.ts`
- Modify: `src/cli.ts`
- Test: `tests/gateway/start.test.ts`, `tests/gateway/ensure.test.ts`

**Interfaces:**
- Produces:

```ts
// start.ts
export interface StartedGateway { port: number; token: string; stop(): Promise<void>; }
export function startGateway(options?: { port?: number; infoPath?: string; log?: (line: string) => void }): Promise<StartedGateway>;
// ensure.ts
export function ensureGateway(options?: { infoPath?: string; spawn?: typeof spawnDetached; timeoutMs?: number }): Promise<GatewayInfo>;
// gateway-command.ts
export function runGatewayStart(): Promise<void>;
export function runGatewayStop(): Promise<void>;
export function runGatewayStatus(): Promise<void>;
```

- [ ] **Step 1: Write the failing test for the factory**

Create `tests/gateway/start.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { startGateway } from '../../src/gateway/start';
import { GatewayClient } from '../../src/gateway/client';
import { readGatewayInfo } from '../../src/gateway/discovery';

function throwawayInfo(): string {
  return path.join(os.tmpdir(), `robin-gw-info-${Date.now()}-${Math.random()}.json`);
}

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe('startGateway', () => {
  it('listens, and records where it is listening', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
    stop = gateway.stop;

    const info = await readGatewayInfo(infoPath);
    expect(info?.port).toBe(gateway.port);
    expect(info?.pid).toBe(process.pid);
    expect(info?.token).toHaveLength(gateway.token.length);
  });

  it('serves a client end to end', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
    stop = gateway.stop;

    const client = await GatewayClient.connect({
      port: gateway.port,
      token: gateway.token,
      kind: 'terminal',
      canApprove: true,
      cwd: '.',
    });
    expect(client.sessions).toEqual([]);
    await client.close();
  });

  it('removes its info file on stop, so nothing chases a dead daemon', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
    await gateway.stop();
    stop = undefined;

    expect(await readGatewayInfo(infoPath)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/gateway/start.test.ts`
Expected: FAIL — cannot resolve `src/gateway/start`.

- [ ] **Step 3: Write `start.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { GatewayServer } from './server.js';
import { SessionService } from './session-service.js';
import { ApprovalRegistry } from './approvals.js';
import { defaultPort, writeGatewayInfo, removeGatewayInfo, defaultGatewayInfoPath } from './discovery.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { listProviders } from '../providers/index.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { ContextLimitStore } from '../providers/context-limits.js';
import { MemoryStore } from '../memory/store.js';
import { SkillStore } from '../skills/store.js';
import { ConversationStore } from '../conversation-store.js';

export interface StartedGateway {
  port: number;
  token: string;
  stop(): Promise<void>;
}

/**
 * Builds the daemon and starts it listening.
 *
 * The three pieces refer to each other — the server broadcasts approvals the
 * registry raises, the registry answers turns the service runs, the service
 * emits events the server delivers. The cycle is resolved here, in one
 * function, so no module has to import another just to be constructed.
 */
export async function startGateway(
  options: { port?: number; infoPath?: string; log?: (line: string) => void } = {}
): Promise<StartedGateway> {
  const log = options.log ?? ((line: string) => console.log(line));
  const infoPath = options.infoPath ?? defaultGatewayInfoPath();
  const token = randomBytes(32).toString('hex');

  let server: GatewayServer;

  const approvals = new ApprovalRegistry({
    broadcast: (pending) => server.broadcastApproval(pending),
    resolved: (pending, approved, by) => server.resolvedApproval(pending, approved, by),
  });

  const sessions = new SessionService({
    providers: listProviders(),
    approvals,
    emit: (sessionId, event) => server.emit(sessionId, event),
    stores: {
      unsupported: new UnsupportedModelStore(),
      contextLimits: new ContextLimitStore(),
      memory: new MemoryStore(),
      skills: new SkillStore(),
      conversation: new ConversationStore(),
    },
  });

  server = new GatewayServer({
    sessions,
    approvals,
    token,
    port: options.port ?? defaultPort(),
    log,
  });

  const port = await server.listen();
  await writeGatewayInfo({ port, pid: process.pid, token, protocol: PROTOCOL_VERSION }, infoPath);
  log(`Robin gateway listening on 127.0.0.1:${port}`);

  return {
    port,
    token,
    async stop(): Promise<void> {
      await server.close();
      // Leaving the file behind would point the next client at a dead port.
      await removeGatewayInfo(infoPath);
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/gateway/start.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `ensureGateway`**

Create `tests/gateway/ensure.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureGateway } from '../../src/gateway/ensure';
import { startGateway } from '../../src/gateway/start';
import { writeGatewayInfo } from '../../src/gateway/discovery';
import { PROTOCOL_VERSION } from '../../src/gateway/protocol';

function throwawayInfo(): string {
  return path.join(os.tmpdir(), `robin-ensure-${Date.now()}-${Math.random()}.json`);
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe('ensureGateway', () => {
  it('uses a gateway that is already running, without spawning', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
    stop = gateway.stop;
    const spawn = vi.fn();

    const info = await ensureGateway({ infoPath, spawn });

    expect(info.port).toBe(gateway.port);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns when nothing is running, and waits for the file to appear', async () => {
    const infoPath = throwawayInfo();
    const spawn = vi.fn(async () => {
      const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
      stop = gateway.stop;
    });

    const info = await ensureGateway({ infoPath, spawn });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(info.protocol).toBe(PROTOCOL_VERSION);
  });

  // A crashed daemon leaves its file behind. Trusting it would send every
  // client at a closed port.
  it('ignores a file whose process is gone and starts fresh', async () => {
    const infoPath = throwawayInfo();
    await writeGatewayInfo(
      { port: 1, pid: 0x7ffffff0, token: 'stale', protocol: PROTOCOL_VERSION },
      infoPath
    );
    const spawn = vi.fn(async () => {
      const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
      stop = gateway.stop;
    });

    const info = await ensureGateway({ infoPath, spawn });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(info.token).not.toBe('stale');
  });

  it('gives up with a useful message when the spawn never comes up', async () => {
    const infoPath = throwawayInfo();
    await expect(
      ensureGateway({ infoPath, spawn: async () => {}, timeoutMs: 200 })
    ).rejects.toThrow(/gateway/i);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/gateway/ensure.test.ts`
Expected: FAIL — cannot resolve `src/gateway/ensure`.

- [ ] **Step 7: Write `ensure.ts`**

```ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  defaultGatewayInfoPath,
  readLiveGatewayInfo,
  type GatewayInfo,
} from './discovery.js';

const WAIT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

/** Launches `robin gateway start` detached, so it outlives this process. */
export async function spawnDetached(): Promise<void> {
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'gateway', 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  // Without this the parent will not exit while the child lives.
  child.unref();
}

/**
 * Returns a gateway to talk to, starting one if there is none.
 *
 * Two `robin chat` invocations can race here and both decide to spawn. That is
 * fine and needs no lock: the loser's daemon fails to bind, exits, and the
 * poll below picks up the winner's file. Polling for the file rather than
 * coordinating is what makes the race harmless.
 */
export async function ensureGateway(
  options: {
    infoPath?: string;
    spawn?: () => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<GatewayInfo> {
  const infoPath = options.infoPath ?? defaultGatewayInfoPath();
  const existing = await readLiveGatewayInfo(infoPath);
  if (existing) return existing;

  await (options.spawn ?? spawnDetached)();

  const deadline = Date.now() + (options.timeoutMs ?? WAIT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const info = await readLiveGatewayInfo(infoPath);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  throw new Error(
    'The Robin gateway did not come up. Run `robin gateway start` in another terminal ' +
      'to see why, or check ~/.robin/gateway.log.'
  );
}
```

- [ ] **Step 8: Run the test**

Run: `npx vitest run tests/gateway/ensure.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the command and wire the CLI**

Create `src/commands/gateway-command.ts`:

```ts
import { startGateway } from '../gateway/start.js';
import {
  readGatewayInfo,
  readLiveGatewayInfo,
  removeGatewayInfo,
  isProcessAlive,
} from '../gateway/discovery.js';
import { PROTOCOL_VERSION } from '../gateway/protocol.js';
import { mutedColor, errorColor } from '../ui/theme.js';

/** Runs in the foreground. `robin chat` spawns this detached. */
export async function runGatewayStart(): Promise<void> {
  const gateway = await startGateway();
  const shutdown = async (): Promise<void> => {
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

export async function runGatewayStop(): Promise<void> {
  const info = await readGatewayInfo();
  if (!info) {
    console.log(mutedColor('No gateway is recorded as running.'));
    return;
  }
  if (!isProcessAlive(info.pid)) {
    await removeGatewayInfo();
    console.log(mutedColor('Cleared a stale gateway record; nothing was running.'));
    return;
  }
  process.kill(info.pid);
  await removeGatewayInfo();
  console.log(`Stopped the gateway (pid ${info.pid}).`);
}

export async function runGatewayStatus(): Promise<void> {
  const info = await readLiveGatewayInfo();
  if (!info) {
    console.log(mutedColor('Not running. `robin chat` will start one when you need it.'));
    return;
  }
  console.log(`Running on 127.0.0.1:${info.port} (pid ${info.pid}), protocol ${info.protocol}.`);
  if (info.protocol !== PROTOCOL_VERSION) {
    console.log(
      errorColor(
        `This build speaks protocol ${PROTOCOL_VERSION}. Run \`robin gateway stop\` — that daemon predates your last build.`
      )
    );
  }
}
```

In `src/cli.ts`, register the command alongside the existing ones:

```ts
const gateway = program.command('gateway').description('the local control plane');
gateway.command('start').description('run the gateway in the foreground').action(runGatewayStart);
gateway.command('stop').description('stop a running gateway').action(runGatewayStop);
gateway.command('status').description('is a gateway running, and where').action(runGatewayStatus);
```

- [ ] **Step 10: Verify by hand**

```bash
npm run build
node dist/cli.js gateway status      # expect: Not running.
node dist/cli.js gateway start &     # or a second terminal
node dist/cli.js gateway status      # expect: Running on 127.0.0.1:18790
node dist/cli.js gateway stop        # expect: Stopped the gateway
node dist/cli.js gateway status      # expect: Not running.
```

On Windows PowerShell, use `Start-Process node -ArgumentList "dist/cli.js gateway start"`.

- [ ] **Step 11: Commit**

```bash
npm run check
git add src/gateway/start.ts src/gateway/ensure.ts src/commands/gateway-command.ts src/cli.ts tests/gateway/start.test.ts tests/gateway/ensure.test.ts
git commit -m "gateway: start it, stop it, find it"
```

---

### Task 10: The REPL becomes a client

**Files:**
- Modify: `src/repl/run-repl.ts`
- Modify: `src/repl/repl-context.ts`
- Create: `src/repl/render-events.ts`
- Test: `tests/repl/render-events.test.ts`

**Interfaces:**
- Consumes: `GatewayClient`, `ensureGateway`, `GatewayEvent`.
- Produces: `ReplContext.client: GatewayClient`, `ReplContext.sessionId: number`;
  `renderEvent(event: GatewayEvent, out: EventOutput): void` where

```ts
export interface EventOutput {
  text(chunk: string): void;
  muted(line: string): void;
  error(line: string): void;
  connectionChanged(providerName: string, model: string): void;
}
```

Extracting rendering into its own module is what makes this testable at all:
`run-repl.ts` owns a socket and a terminal, and neither belongs in a unit test.

- [ ] **Step 1: Write the failing test**

Create `tests/repl/render-events.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderEvent } from '../../src/repl/render-events';

function output() {
  return { text: vi.fn(), muted: vi.fn(), error: vi.fn(), connectionChanged: vi.fn() };
}

describe('renderEvent', () => {
  it('writes streamed text straight through', () => {
    const out = output();
    renderEvent({ kind: 'text', turnId: 't', delta: 'hello' }, out);
    expect(out.text).toHaveBeenCalledWith('hello');
  });

  it('shows an auto-approved command so the user knows what ran', () => {
    const out = output();
    renderEvent({ kind: 'tool.auto_approved', turnId: 't', command: 'dir' }, out);
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('dir'));
  });

  it('reports a fallback with the model it moved to', () => {
    const out = output();
    renderEvent(
      { kind: 'fallback', turnId: 't', message: '429', providerName: 'Ollama', model: 'llama3.1' },
      out
    );
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('llama3.1'));
  });

  it('says how much history was dropped', () => {
    const out = output();
    renderEvent({ kind: 'trim', turnId: 't', dropped: 4, limit: 12288 }, out);
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('4'));
  });

  it('reports a failed turn as an error', () => {
    const out = output();
    renderEvent(
      {
        kind: 'turn.finished',
        turnId: 't',
        ok: false,
        aborted: false,
        providerName: 'X',
        model: 'y',
        error: 'boom',
      },
      out
    );
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('announces a model change so the status line stays true', () => {
    const out = output();
    renderEvent(
      {
        kind: 'session.changed',
        snapshot: {
          id: 1,
          providerId: 'ollama',
          providerName: 'Ollama (local)',
          model: 'llama3.1',
          cwd: '.',
          toolsEnabled: true,
          autoApprove: false,
          turnCount: 1,
          busy: false,
          queued: 0,
        },
      },
      out
    );
    expect(out.connectionChanged).toHaveBeenCalledWith('Ollama (local)', 'llama3.1');
  });

  it('says nothing at all for a clean finish — the text already said it', () => {
    const out = output();
    renderEvent(
      { kind: 'turn.finished', turnId: 't', ok: true, aborted: false, providerName: 'X', model: 'y' },
      out
    );
    expect(out.error).not.toHaveBeenCalled();
    expect(out.muted).not.toHaveBeenCalled();
  });

  it('says so when the turn was interrupted', () => {
    const out = output();
    renderEvent(
      { kind: 'turn.finished', turnId: 't', ok: true, aborted: true, providerName: 'X', model: 'y' },
      out
    );
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('Interrupted'));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/repl/render-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `render-events.ts`**

```ts
import type { GatewayEvent } from '../gateway/protocol.js';

export interface EventOutput {
  text(chunk: string): void;
  muted(line: string): void;
  error(line: string): void;
  connectionChanged(providerName: string, model: string): void;
}

/**
 * Turns one gateway event into terminal output.
 *
 * Split out of run-repl so it can be tested without a socket or a TTY. The
 * approval events are handled in run-repl instead: they need a prompt, not a
 * line of output.
 */
export function renderEvent(event: GatewayEvent, out: EventOutput): void {
  switch (event.kind) {
    case 'text':
      out.text(event.delta);
      return;
    case 'thinking':
      out.muted(event.delta);
      return;
    case 'tool.auto_approved':
      out.muted(`\n  $ ${event.command}`);
      return;
    case 'tool.output':
      out.muted(event.chunk);
      return;
    case 'fallback':
      out.muted(`\n  ${event.message} — trying ${event.providerName} · ${event.model}...`);
      return;
    case 'trim':
      out.muted(
        `\n  Dropped the oldest ${event.dropped} message(s) to fit ${event.limit} tokens. /clear starts fresh.`
      );
      return;
    case 'session.changed':
      out.connectionChanged(event.snapshot.providerName, event.snapshot.model);
      return;
    case 'turn.finished':
      if (event.aborted) out.muted('Interrupted. Your next message continues from here.');
      else if (!event.ok) out.error(`\n✖ ${event.error ?? 'The turn failed.'}`);
      return;
    default:
      // turn.started and the approval events are handled by the caller.
      return;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/repl/render-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite `run-repl.ts` as a client**

Replace the store wiring and turn invocation. The shape:

```ts
  const info = await ensureGateway();
  const client = await GatewayClient.connect({
    port: info.port,
    token: info.token,
    kind: 'terminal',
    canApprove: true,
    cwd: process.cwd(),
  });

  // Reuse a session this terminal's directory already owns, else make one.
  // Continuing where you left off is the whole point of the daemon.
  const existing = client.sessions.find((s) => s.cwd === process.cwd());
  const snapshot =
    existing ??
    (await client.request<SessionSnapshot>('session.create', {
      providerId: deps.provider.id,
      model: deps.model,
      cwd: process.cwd(),
    }));
  const attached = await client.request<AttachResult>('session.attach', { id: snapshot.id });
```

Event handling, with approvals prompted rather than printed:

```ts
  const pendingApprovals = new Map<string, { cancel: () => void }>();

  client.on((_sessionId, event) => {
    if (event.kind === 'approval.request') {
      void askApproval(event);
      return;
    }
    if (event.kind === 'approval.resolved') {
      // Another terminal answered first. Withdraw the box rather than leaving
      // a dead question on screen.
      pendingApprovals.get(event.approvalId)?.cancel();
      pendingApprovals.delete(event.approvalId);
      return;
    }
    renderEvent(event, replOutput);
  });

  client.onClose(() => {
    console.log(errorColor('\n✖ The gateway went away. Restart robin to reconnect.'));
    process.exit(1);
  });
```

`askApproval` renders the box with its origin line and sends the answer:

```ts
async function askApproval(event: Extract<GatewayEvent, { kind: 'approval.request' }>): Promise<void> {
  const { question, scope } = APPROVAL_WORDING[event.request.kind];
  const origin =
    event.origin.surface === 'terminal'
      ? []
      : [
          // Without this you cannot tell a command you asked for from one a
          // remote message asked for, and the gate stops meaning anything.
          `Requested from ${event.origin.surface}${event.origin.who ? ` by ${event.origin.who}` : ''}`,
        ];
  console.log(`\n${box([...origin, ...event.request.message.split('\n')])}`);

  const prompt = expand<ApprovalAnswer>({ message: question, default: 'n', choices: [...] });
  pendingApprovals.set(event.approvalId, { cancel: () => prompt.cancel?.() });
  const answer = await prompt.catch(() => 'no' as const);
  pendingApprovals.delete(event.approvalId);
  await client.request('approval.answer', {
    approvalId: event.approvalId,
    approved: answer === 'yes' || answer === 'always',
  });
}
```

- [ ] **Step 6: Verify the prompt is cancellable — the spec's open question**

Run this scratch check before relying on `prompt.cancel()`:

```bash
node -e "import('@inquirer/prompts').then(({expand})=>{const p=expand({message:'x',default:'n',choices:[{key:'y',name:'yes',value:'yes'}]});console.log('cancel is', typeof p.cancel);setTimeout(()=>{p.cancel?.();process.exit(0)},100)})"
```

Expected: prints `cancel is function`. **If it prints `undefined`**, take the
fallback the spec names: drop `cancel`, leave the box on screen, and when the
stray answer arrives send it anyway — the gateway ignores an answer to a
settled approval (Task 4 tests this), so print
`mutedColor('Another terminal answered first.')` and move on. Record which
branch was taken in the commit message.

Note also that the session-scoped "always" and "stop asking for this reply"
choices are now the *gateway's* memory, not the REPL's. The REPL sends the
answer; `ApprovalRegistry` decides what to remember. Keep the four choices in
the prompt but map them: `yes`/`always` → approved, `no`/`never` → denied, and
send `always`/`never` as an extra `scope` param only once a later milestone
adds it. **For this milestone, present only `yes` and `no`.** Two choices that
work beat four where two silently do nothing.

- [ ] **Step 7: Run the whole suite**

Run: `npm run check`
Expected: PASS. `tests/repl/*` that constructed a `ReplContext` with `stores`
will need their fixtures updated to the new shape — that is expected work in
this task, not a surprise.

- [ ] **Step 8: Verify by hand**

```bash
npm run build
node dist/cli.js chat ollama
# type: hello
# expect: a reply, and `node dist/cli.js gateway status` in another terminal
#         shows the daemon running
```

- [ ] **Step 9: Commit**

```bash
git add src/repl/run-repl.ts src/repl/repl-context.ts src/repl/render-events.ts tests/repl/render-events.test.ts
git commit -m "repl: render what the gateway is doing instead of doing it"
```

---

### Task 11: Session-state commands over RPC

**Files:**
- Modify: `src/repl/commands/connection.ts` (`/model`, `/provider`, `/random`, `/system`, `/tools`)
- Modify: `src/repl/commands/conversation.ts` (`/clear`)
- Modify: `src/repl/commands/session.ts` (`/session`)
- Test: `tests/repl/commands/connection.test.ts` (update), `tests/repl/commands/session.test.ts` (update)

**Interfaces:**
- Consumes: `ReplContext.client`, `ReplContext.sessionId` from Task 10.
- Produces: no new exports; handler signatures are unchanged.

- [ ] **Step 1: Write the failing test**

In `tests/repl/commands/connection.test.ts`, replace the session-mutation
assertions with RPC assertions. A fake client keeps this honest:

```ts
function fakeClient() {
  return {
    request: vi.fn().mockResolvedValue({
      id: 1,
      providerId: 'ollama',
      providerName: 'Ollama (local)',
      model: 'llama3.1',
      cwd: '.',
      toolsEnabled: true,
      autoApprove: false,
      turnCount: 0,
      busy: false,
      queued: 0,
    }),
  };
}

it('asks the gateway to switch model, rather than mutating a local session', async () => {
  const client = fakeClient();
  const ctx = { client, sessionId: 1, deps: { pickModel: async () => 'llama3.1' } } as never;

  await handleModel(ctx);

  expect(client.request).toHaveBeenCalledWith('session.update', {
    id: 1,
    patch: { model: 'llama3.1' },
  });
});

it('clears the system prompt with an explicit null, not by omitting it', async () => {
  const client = fakeClient();
  const ctx = { client, sessionId: 1 } as never;

  await handleSystem(ctx, 'clear');

  // undefined would mean "leave it alone" over a wire protocol; null is the
  // only way to say "remove it".
  expect(client.request).toHaveBeenCalledWith('session.update', {
    id: 1,
    patch: { systemPrompt: null },
  });
});

it('toggles tools by sending the value it wants, not a toggle', async () => {
  const client = fakeClient();
  client.request.mockResolvedValue({ toolsEnabled: false });
  const ctx = { client, sessionId: 1, snapshot: { toolsEnabled: true } } as never;

  await handleTools(ctx);

  // A toggle sent over a wire races with any other client toggling it. Send
  // the intended state and let the gateway be the single source of truth.
  expect(client.request).toHaveBeenCalledWith('session.update', {
    id: 1,
    patch: { toolsEnabled: false },
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/repl/commands/connection.test.ts`
Expected: FAIL — the handlers still mutate `ctx.session`.

- [ ] **Step 3: Rewrite the handlers**

```ts
async function applyConnectionChange(
  ctx: ReplContext,
  patch: { providerId?: string; model?: string }
): Promise<void> {
  const snapshot = await ctx.client.request<SessionSnapshot>('session.update', {
    id: ctx.sessionId,
    patch,
  });
  // The gateway clears history on a connection switch and emits
  // session.changed, which prints the connection line. Nothing to do here.
  ctx.snapshot = snapshot;
}

export async function handleModel(ctx: ReplContext): Promise<void> {
  const model = await ctx.deps.pickModel(providerById(ctx.snapshot.providerId));
  await applyConnectionChange(ctx, { model });
}
```

`/session` becomes `session.list` plus `session.attach`, and gains what it
could not show before: which sessions belong to other surfaces, whether each is
busy, and which carry `autoApprove`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/repl`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/repl/commands tests/repl/commands
git commit -m "repl: session commands ask the gateway"
```

---

### Task 12: Store-backed commands over RPC — **DROPPED, not built**

This task was written on a premise that does not hold. It exists to give the
daemon "one owner for the stores too", but `MemoryStore` and `SkillStore` never
cached: every `list()` and `read()` goes to disk, and both processes read the
same directory. A memory the model writes inside the daemon already appears in
`/memory` immediately. The remaining stores are REPL-only by nature — input
history, the OpenRouter spend figure, the trust file, workflow definitions.

Building it would have added a protocol surface, a round-trip per command and
roughly 300 lines, for behaviour identical to what already happens.

**It did surface a real bug next door, which was fixed instead.**
`UnsupportedModelStore` and `ContextLimitStore` *do* cache in memory, and the
gateway holds them for its whole life. `robin models forget` runs in a separate
process: it cleared the file while the daemon kept serving its stale copy, so a
model the user had just asked to retry stayed hidden until the gateway was
restarted. Before the gateway this could not happen — the process holding the
cache was the one you would restart anyway. Both stores now revalidate on
mtime and size. See `tests/providers/store-staleness.test.ts`.

**When this task becomes real:** a browser or remote client cannot read
`~/.robin` directly, so a control UI would need these methods. That is the
milestone to build them in, against a client that actually needs them.

The original plan follows, unbuilt.

### Task 12 (original, unbuilt): Store-backed commands over RPC

**Files:**
- Modify: `src/repl/commands/conversation.ts` (`/save`, `/load`), `skill.ts`, `memory.ts`, `personality.ts`, `workflow.ts`, `history.ts` (`/recall`)
- Modify: `src/gateway/server.ts` and `src/gateway/session-service.ts` (add the methods these need)
- Test: `tests/gateway/store-methods.test.ts`, plus updates to the affected command tests

**Interfaces:**
- Produces on the protocol: `memory.list`, `memory.forget`, `skill.list`, `skill.save`, `workflow.list`, `workflow.run`, `recall.search`, `conversation.save`, `conversation.load`, `conversation.list`, `personality.show`.

These are thin pass-throughs to stores the daemon already owns. Each takes the
store method's parameters and returns its result.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/store-methods.test.ts`, exercising them through a real
client and server with throwaway store paths:

```ts
it('lists memories through the gateway', async () => {
  // ...start a gateway with a MemoryStore pointed at a temp directory,
  // write one memory, then:
  const result = await client.request<{ memories: { name: string }[] }>('memory.list');
  expect(result.memories.map((m) => m.name)).toContain('a-memory');
});

it('refuses a store method before connect', async () => {
  // Same gate as every other method: no token, no stores.
});
```

Write one such test per method, following the shape above. They are repetitive
by nature; do not collapse them into a loop, because each method's parameters
and result shape differ and a loop would assert only the shared part.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/gateway/store-methods.test.ts`
Expected: FAIL — `unknown-method` for each.

- [ ] **Step 3: Add the methods**

Add a `StoreService` to `src/gateway/` rather than growing `SessionService`:
its responsibility is different — it holds no session state and runs no turns.

```ts
export class StoreService {
  constructor(private readonly stores: { memory: MemoryStore; skills: SkillStore; /* ... */ }) {}
  async memoryList(): Promise<{ memories: MemoryIndexEntry[] }> { ... }
  async memoryForget(name: string): Promise<{ forgotten: boolean }> { ... }
  // ...
}
```

Dispatch to it from `server.ts`'s switch, in a second `switch` guarded by the
`store.` prefix so the two families stay visibly separate.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/gateway`
Expected: PASS.

- [ ] **Step 5: Point the command handlers at it, and run everything**

Run: `npm run check`

- [ ] **Step 6: Commit**

```bash
git add src/gateway src/repl/commands tests/gateway tests/repl
git commit -m "gateway: one owner for the stores too"
```

---

### Task 13: The Telegram bridge becomes a client

**Files:**
- Modify: `src/channels/bridge.ts`
- Modify: `src/commands/serve-command.ts`
- Test: `tests/channels/bridge.test.ts` (update)

**Interfaces:**
- Consumes: `GatewayClient`, `ensureGateway`.
- Produces: `BridgeOptions` loses `provider`, `model`, `stores`; gains
  `client: GatewayClient`, `providerId: string`, `model: string`.

- [ ] **Step 1: Write the failing test**

```ts
it('sends an allowed message to the gateway rather than running a turn itself', async () => {
  const client = fakeClient();
  const bridge = new ChannelBridge({ transport, client, providerId: 'copilot', model: 'gpt-4o', allowlist: ['1'] });

  await deliver({ chatId: 'c1', senderId: '1', text: 'hello' });

  expect(client.request).toHaveBeenCalledWith('prompt.send', expect.objectContaining({ text: 'hello' }));
});

it('creates one gateway session per chat and reuses it', async () => {
  // Two messages from the same chatId produce one session.create.
});

it('marks the origin so an approval box can name the sender', async () => {
  expect(client.request).toHaveBeenCalledWith(
    'prompt.send',
    expect.objectContaining({ surface: 'telegram', who: '@sam' })
  );
});

it('sends the reply only when the turn finishes', async () => {
  // Telegram cannot stream: accumulate `text` events, post on turn.finished.
});

it('still refuses a sender who is not on the allowlist, before any gateway call', async () => {
  expect(client.request).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/channels/bridge.test.ts`

- [ ] **Step 3: Rewrite the bridge**

Delete `sessions`, `queues`, and the store fields — the daemon owns all three
now. Keep `checkAccess` exactly where it is: the allowlist is the bridge's own
responsibility and must run before anything reaches the gateway. Map each
`chatId` to a gateway session id, accumulate `text` events per `turnId`, and
post on `turn.finished`.

`serve-command.ts` calls `ensureGateway()`, connects with
`canApprove: false`, and passes `autoApprove` from `--allow-tools` into
`session.create`.

- [ ] **Step 4: Run everything, and verify by hand if a bot token is available**

Run: `npm run check`

Manual, with a token configured: start `robin chat` in the repo, send a
Telegram message, confirm the terminal shows the reply arriving and that a
`run_command` from Telegram prompts in the terminal with a "Requested from
telegram" line.

- [ ] **Step 5: Commit**

```bash
git add src/channels/bridge.ts src/commands/serve-command.ts tests/channels
git commit -m "channels: the bridge is a client like any other"
```

---

### Task 14: Doctor check and documentation

**Files:**
- Modify: `src/commands/doctor-command.ts`
- Modify: `src/startup/preflight.ts` (if the port check belongs there)
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-13-gateway-daemon-design.md` (correct the "tools unchanged" claim)
- Test: `tests/commands/doctor.test.ts` (update)

- [ ] **Step 1: Write the failing test**

```ts
it('reports a healthy gateway', async () => {
  // With a live gateway, the check passes and names the port.
});

it('reports a stale gateway record as fixable, with the command that fixes it', async () => {
  // Info file present, pid dead → failure whose fix mentions `robin gateway stop`.
});

it('reports a protocol mismatch as the reason to restart it', async () => {
  // Info file with protocol 999 → failure mentioning `robin gateway stop`.
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/commands/doctor.test.ts`

- [ ] **Step 3: Add the check**

Follow the existing check shape in `src/startup/preflight.ts` — each check
returns a pass/fail plus the exact command that fixes it. A gateway that is not
running is **not** a failure: `robin chat` starts one on demand.

- [ ] **Step 4: Document it**

In `README.md`, add a section after "Automatic model fallback":

- What the gateway is, in three sentences.
- That `robin chat` starts it automatically and nobody needs to think about it.
- `robin gateway start|stop|status`.
- That sessions are shared: the terminal and Telegram see one conversation.
- That an approval raised by a Telegram turn appears at the keyboard, with the
  origin line, and that no attached terminal still means denied.
- `~/.robin/gateway.json` (0600, loopback, token) and `~/.robin/gateway.log`.
- `ROBIN_GATEWAY_PORT`.
- The honest limitation: **sessions do not survive a gateway restart.**

Correct the spec's "Unchanged" list to acknowledge Task 3's change to
`src/tools/execute.ts`.

- [ ] **Step 5: Full check and commit**

```bash
npm run check
git add src/commands/doctor-command.ts src/startup/preflight.ts README.md docs tests
git commit -m "docs: what the gateway is, and how to tell it is unwell"
```

---

## Self-Review

**Spec coverage.** Daemon and ownership → Tasks 5, 6, 9. Transport and port →
Tasks 7, 9. Auth → Tasks 2, 7, 9. Lifecycle → Task 9. Protocol methods and
events → Tasks 1, 7, 8, 12. Attach snapshot → Tasks 5, 10. FIFO queue → Task 6.
Worked example end to end → Tasks 10, 13. Component table → Tasks 1–9, with
`StoreService` added in Task 12 (the spec folded stores into `session-service`;
splitting them keeps each file to one responsibility). Approvals, origin line,
autoApprove, timeout, decline memory → Tasks 4, 10, 13. Failure modes: version
skew → Tasks 7, 9, 14; auto-start race → Task 9; stale file → Tasks 2, 9;
daemon dies → Tasks 8, 10; client dies → Task 6 (the turn is queue-owned, not
connection-owned); orphaned approval → Task 4. Non-goals are respected: no HTTP,
no UI, no new channels, no cwd re-binding, no session persistence.

**Gap found and filled:** the spec listed `tools/` as unchanged, which is wrong
— per-session cwd requires threading it through `executeTool`. Task 3 was added
and the spec correction is scheduled in Task 14.

**Placeholders:** none. Task 12's per-method tests are described by shape with
one worked example rather than fifteen near-identical blocks; that is a
deliberate call and the instruction not to collapse them into a loop is
explicit.

**Type consistency:** `SessionSnapshot`, `GatewayEvent`, `PendingApproval`,
`ApprovalOrigin`, `GatewayInfo`, `PromptAccepted` and `AttachResult` are
defined once in Task 1 or 2 and used with the same field names throughout.
`session.update` takes `{ id, patch }` in Tasks 7, 11 and 12 alike.
`systemPrompt: null` for clearing is specified in Task 5 and asserted in
Task 11. `ApprovalRegistry.confirmFor(sessionId, origin, autoApprove)` matches
its call in Task 6.
