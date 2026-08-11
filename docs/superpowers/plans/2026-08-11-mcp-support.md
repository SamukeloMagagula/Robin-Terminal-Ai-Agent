# MCP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Robin connect to Model Context Protocol servers over stdio, exposing their tools to the model alongside its own three built-ins — without weakening the approval gate or the untrusted-output boundary.

**Architecture:** Config → lazy client → registry that merges MCP tools into `TOOL_DEFINITIONS` under a `server__tool` namespace. Every MCP call goes through the existing approval gate and `wrapUntrusted`. A server entry is a command Robin will execute, so it goes through the same content-hash trust gate `PERSONALITY.md` uses — generalised here so there is one trust store, not two.

**Tech Stack:** TypeScript 5.9.3 (ESM, `NodeNext`), Node ≥ 18, Vitest 2.1.9, `@modelcontextprotocol/sdk` **1.30.0** (already installed, exact-pinned).

**Source spec:** `docs/superpowers/specs/2026-08-11-mcp-tui-memory-recall-design.md`, Section 1. Sections 2–4 are done or separately planned.

## Global Constraints

- **ESM with explicit extensions** on relative imports (`./foo.js`). MCP SDK subpath imports also carry `.js`: `@modelcontextprotocol/sdk/client/index.js`.
- **The verified SDK surface** (checked against the installed 1.30.0, do not improvise):
  - `import { Client } from '@modelcontextprotocol/sdk/client/index.js'` — `new Client({name, version}, {capabilities})`, then `.connect(transport)`, `.listTools()`, `.callTool({name, arguments})`, `.close()`.
  - `import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'` — `new StdioClientTransport({command, args?, env?, cwd?, stderr?})`.
  - If a binding you need is not listed here, read the `.d.ts` under `node_modules/@modelcontextprotocol/sdk/dist/esm/client/` rather than guessing.
- **No MCP tool ever auto-approves.** `command-safety.ts` can classify Robin's own shell commands; there is no equivalent analysis for an opaque third-party tool, and inferring safety from a name the server chose would be trusting the thing being gated.
- **Every MCP result is wrapped with `wrapUntrusted`** — a server's response is attacker-controlled text entering the model's context.
- **One bad server must never break the session.** Each failure disables that server with a muted line and leaves the turn running on the remaining tools.
- **Verification:** `npm run check`. Single file: `npx vitest run tests/path/file.test.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `src/mcp/config.ts` (create) | Load and validate `~/.robin/mcp.json`; fails closed to zero servers |
| `src/trust-store.ts` (create) | Category-keyed content-hash trust, generalised from `personality-trust.ts` |
| `src/personality-trust.ts` (modify) | Thin wrapper over `TrustStore` with category `personality` |
| `src/mcp/client.ts` (create) | One lazy connection per server; discovery and invocation |
| `src/mcp/registry.ts` (create) | Namespacing, merge into tool definitions, per-server failure isolation |
| `src/tools/execute.ts` (modify) | `mcp_tool` confirm kind; route namespaced calls to the registry |
| `src/repl/run-repl.ts` (modify) | Build the registry at startup, behind the trust prompt |

---

### Task 1: Load and validate `mcp.json`

**Files:** Create `src/mcp/config.ts`; test `tests/mcp/config.test.ts`

**Produces:** `McpServerConfig`, `McpConfig`, `loadMcpConfig(path?)`, `defaultMcpConfigPath()`, `serverFingerprint(name, config)`.

**Context:** The shape matches what other MCP hosts use, so server blocks can be pasted from their docs. A corrupt file fails closed to zero servers, following `conversation-store.ts:31-41`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadMcpConfig, serverFingerprint } from '../../src/mcp/config';

async function withConfig(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-mcp-'));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, contents);
  return file;
}

describe('loadMcpConfig', () => {
  it('returns no servers when the file does not exist', async () => {
    expect(await loadMcpConfig('/nonexistent/mcp.json')).toEqual([]);
  });

  it('reads a well-formed config', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } } })
    );

    expect(await loadMcpConfig(file)).toEqual([
      { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: undefined, cwd: undefined },
    ]);
  });

  it('fails closed on malformed JSON', async () => {
    expect(await loadMcpConfig(await withConfig('{ not json'))).toEqual([]);
  });

  it('fails closed on the wrong shape', async () => {
    expect(await loadMcpConfig(await withConfig('["nope"]'))).toEqual([]);
  });

  it('skips an entry with no command rather than failing the whole file', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { good: { command: 'a' }, bad: { args: ['x'] } } })
    );

    const servers = await loadMcpConfig(file);
    expect(servers.map((s) => s.name)).toEqual(['good']);
  });

  it('rejects a server name that would break the tool namespace', async () => {
    // "a__b" would make server__tool ambiguous.
    const file = await withConfig(
      JSON.stringify({ servers: { 'a__b': { command: 'x' }, ok: { command: 'y' } } })
    );

    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['ok']);
  });
});

describe('serverFingerprint', () => {
  it('changes when the command changes', () => {
    const a = serverFingerprint('fs', { name: 'fs', command: 'npx', args: ['-y', 'x'] });
    const b = serverFingerprint('fs', { name: 'fs', command: 'npx', args: ['-y', 'y'] });
    expect(a).not.toBe(b);
  });

  it('is stable for the same entry', () => {
    const cfg = { name: 'fs', command: 'npx', args: ['-y', 'x'] };
    expect(serverFingerprint('fs', cfg)).toBe(serverFingerprint('fs', cfg));
  });
});
```

- [ ] **Step 2: Run it — expect a resolve failure**

Run: `npx vitest run tests/mcp/config.test.ts`

- [ ] **Step 3: Implement**

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export function defaultMcpConfigPath(): string {
  return path.join(os.homedir(), '.robin', 'mcp.json');
}

/**
 * Server names become the first half of a `server__tool` identifier, so a name
 * containing the separator would make the split ambiguous — and an ambiguous
 * split is how a server shadows a built-in tool.
 */
function isValidServerName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.includes('__');
}

/**
 * Servers declared in ~/.robin/mcp.json.
 *
 * Fails closed: an unreadable or malformed file yields zero servers rather
 * than throwing, and one bad entry is skipped rather than discarding the rest.
 * Robin must stay usable when this file is wrong.
 */
export async function loadMcpConfig(
  filePath: string = defaultMcpConfigPath()
): Promise<McpServerConfig[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const servers = (parsed as { servers?: unknown }).servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];

  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!isValidServerName(name)) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== 'string' || !entry.command) continue;
    out.push({
      name,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined,
      env: isStringMap(entry.env) ? entry.env : undefined,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    });
  }
  return out;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

/** The exact command this entry will run — what the user is asked to approve. */
export function serverFingerprint(name: string, config: McpServerConfig): string {
  return JSON.stringify({
    name,
    command: config.command,
    args: config.args ?? [],
    env: Object.keys(config.env ?? {}).sort(),
    cwd: config.cwd ?? null,
  });
}
```

Note `env` contributes only its **keys** to the fingerprint, never its values — a token rotating in `mcp.json` must not re-prompt, and the fingerprint is written to disk.

- [ ] **Step 4: Run — expect PASS (8 tests)**
- [ ] **Step 5: Commit** — `feat: load and validate ~/.robin/mcp.json`

---

### Task 2: Generalise the trust store

**Files:** Create `src/trust-store.ts`; modify `src/personality-trust.ts`; test `tests/trust-store.test.ts`

**Produces:** `TrustStore` with `isTrusted(category, key, content)`, `trustContent(...)`, `trustKey(...)`.

**Context:** Task 5 needs the same content-hash gate `PERSONALITY.md` uses. One store, keyed by category, rather than a second copy. `PersonalityTrustStore` becomes a wrapper so its existing tests pass unchanged — **that is the acceptance criterion for this task.**

Existing files are `{ "<abs path>": { "hash": ... } }`. Migrate on read by treating an un-categorised file as category `personality`.

- [ ] **Step 1: Write `tests/trust-store.test.ts`** covering: nothing trusted by default; `trustContent` then same content trusted; edited content not trusted; `trustKey` trusts any content; categories are independent (same key trusted under `personality` is not trusted under `mcp-server`); corrupt file fails closed; a legacy un-categorised file still grants personality trust.
- [ ] **Step 2: Run — expect failure**
- [ ] **Step 3: Implement `TrustStore`**, file shape `{ "<category>": { "<key>": { "hash"?: string } } }`, `0o700`/`0o600` + explicit `chmod` per `auth-store.ts:41-50`, and legacy migration on read.
- [ ] **Step 4: Rewrite `PersonalityTrustStore` as a wrapper** delegating to `TrustStore` with category `personality`, keeping its exact public methods.
- [ ] **Step 5: Run `npm run check`** — `tests/personality-trust.test.ts` and the personality cases in `tests/hardening.test.ts` must pass **untouched**. Any needed edit there means the wrapper changed behaviour.
- [ ] **Step 6: Commit** — `refactor: generalise the trust store so MCP can reuse it`

---

### Task 3: Connect to a server and discover its tools

**Files:** Create `src/mcp/client.ts`; test `tests/mcp/client.test.ts`

**Produces:** `McpConnection` with `connect()`, `listTools()`, `callTool(name, args)`, `close()`; and `McpToolInfo { name, description, inputSchema }`.

**Context:** Lazy — nothing spawns until a turn needs tools, so a user who never enables tools pays nothing. A 10s startup timeout; a server that will not start is disabled, not retried.

Tests use a **real stdio server**: a tiny Node script fixture, since mocking the SDK's transport tests nothing about whether the integration works.

- [ ] **Step 1: Write the fixture** `tests/mcp/fixtures/echo-server.mjs` — a minimal MCP server over stdio exposing one `echo` tool, built with `Server` + `StdioServerTransport` from `@modelcontextprotocol/sdk/server/…`. Read the `.d.ts` under `node_modules/@modelcontextprotocol/sdk/dist/esm/server/` for the exact bindings.
- [ ] **Step 2: Write `tests/mcp/client.test.ts`** — connects to the fixture, lists one tool named `echo`, calls it and gets the argument back, `close()` terminates the child, and a nonexistent command rejects rather than hanging.
- [ ] **Step 3: Run — expect failure**
- [ ] **Step 4: Implement** using `new Client({ name: 'robin', version: '0.1.0' }, { capabilities: {} })` and `new StdioClientTransport({ command, args, env, cwd })`, with a `Promise.race` startup timeout.
- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit** — `feat: connect to an MCP server over stdio`

---

### Task 4: Namespace and merge tools into the registry

**Files:** Create `src/mcp/registry.ts`; test `tests/mcp/registry.test.ts`

**Produces:** `McpRegistry` with `load(servers)`, `toolDefinitions()`, `call(namespacedName, args)`, `has(name)`, `closeAll()`.

**Context and the security-critical part.** Tools are exposed as `server__tool`. **Without the prefix a server could declare `read_file` and shadow the built-in, intercepting every call** — the prefix is a boundary, not cosmetics. `has()` is what `execute.ts` uses to decide whether a call is MCP's; it must return false for every built-in name.

- [ ] **Step 1: Write the failing tests** — with stub connections:
  - a tool named `read_file` on server `fs` is exposed as `fs__read_file`, and `has('read_file')` is **false**
  - two servers exposing the same tool name produce distinct namespaced names
  - a server whose `connect()` rejects contributes no tools, and the other server's tools are still present
  - `call()` on an unknown namespaced name returns an error string rather than throwing
  - `closeAll()` closes every connection, including after a failure
- [ ] **Step 2: Run — expect failure**
- [ ] **Step 3: Implement.** `load()` connects each server inside its own `try`/`catch`, reporting failures through an injected `onError(serverName, message)` rather than printing. `toolDefinitions()` maps `McpToolInfo` to Robin's `ToolDefinition` (`inputSchema` → `parameters`).
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat: namespace MCP tools as server__tool`

---

### Task 5: Route MCP calls through the approval gate

**Files:** Modify `src/tools/execute.ts`, `src/repl/run-repl.ts`, `src/repl/run-turn.ts`; test `tests/tools/execute.test.ts`, `tests/hardening.test.ts`

**Context:** This is the task to review hardest — it is where the security properties are actually enforced.

- [ ] **Step 1: Write the failing tests.** In `tests/hardening.test.ts` (security suite):
  - an MCP tool call with `confirm` returning **false** does not invoke the registry and returns a declined message
  - an MCP tool call **never** auto-approves, even when its name would look read-only to `isReadOnlyCommand` (e.g. a tool named `ls`)
  - the result is wrapped by `wrapUntrusted` — assert the wrapper markers are present
  - a server named in `mcp.json` but not trusted contributes no tools
- [ ] **Step 2: Run — expect failure**
- [ ] **Step 3: Add the confirm kind.** `ConfirmRequest['kind']` gains `'mcp_tool'`; `APPROVAL_WORDING` in `run-repl.ts` gains `mcp_tool: { question: 'Run it?', scope: 'MCP tools' }`.
- [ ] **Step 4: Route in `execute.ts`.** `ExecuteOptions` gains `mcp?: { has(name): boolean; call(name, args): Promise<string> }`. In `executeTool`, **before** the built-in `switch`, if `options.mcp?.has(toolCall.name)`, confirm with kind `mcp_tool` and a message naming the server, tool and arguments; on approval call the registry and return `wrapUntrusted(\`output of ${name}\`, result)`; on refusal return a declined message. Never consult `isReadOnlyCommand`.
- [ ] **Step 5: Wire startup in `run-repl.ts`.** Load config; for each server, check `TrustStore` under category `mcp-server` with `serverFingerprint` as the content — an untrusted entry prints the command and prompts (`y` / `n` / `a`, the same two grants as personality); build the registry from trusted servers only; append `registry.toolDefinitions()` to `TOOL_DEFINITIONS` for the turn; pass `mcp` into `runTurn`'s execute options; `closeAll()` on `/exit`.
- [ ] **Step 6: Run `npm run check`** — all pass, hardening suite green.
- [ ] **Step 7: Manual check.** With a real server:
  ```jsonc
  { "servers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }
  ```
  Confirm: the trust prompt appears and names the command; declining yields no MCP tools; accepting exposes `fs__*` in `/tools list`; calling one prompts for approval every time; killing the server mid-session disables it without ending the turn.
- [ ] **Step 8: README** — an MCP section covering `mcp.json`, the namespace, the trust prompt, and why nothing auto-approves.
- [ ] **Step 9: Commit** — `feat: expose MCP tools behind the approval gate`

---

## Self-Review

**Spec coverage.** Config → Task 1. Trust gate → Tasks 2 and 5. Lazy client and startup timeout → Task 3. `server__tool` namespacing and per-server failure isolation → Task 4. Approval gate, no auto-approve, `wrapUntrusted` → Task 5. stdio-only and tools-only are inherited from the spec's Out of Scope.

**Deliberately deferred:** the spec's failure table lists "server dies mid-session → disabled, not retried". Task 4 covers connect-time failure; mid-session death surfaces as a `call()` error string. Detecting a dead process and disabling it up front is **not** implemented — the tool call fails with an error the model sees, which is survivable but noisier than the spec implies. Worth a follow-up.

**Known gaps:**

- **Task 3 uses a real child process**, so those tests are slower and can be flaky under load. That is the deliberate trade: mocking the transport would test nothing about whether the SDK integration works.
- **Task 5's manual check is the only end-to-end proof.** No automated test spawns a real MCP server *through the REPL*.
- **The `env` fingerprint covers keys, not values** (Task 1), so a rotated token does not re-prompt. That is intentional — but it means a changed *secret* is trusted silently. Right call for usability, worth knowing.
