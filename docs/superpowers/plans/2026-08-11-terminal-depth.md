# Terminal Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Robin's prompt hold multiline input, let Esc interrupt a streaming reply, and stream long-running command output live instead of buffering it.

**Architecture:** Three independent pieces, ordered so the riskiest lands first. An `AbortSignal` threads from the REPL through `runTurn` → `runAgentTurn` → every provider's `fetch`. Aborting is modelled as a *normal return* carrying a partial reply, not an error, so it can never be mistaken for a provider failure and trigger the fallback chain.

**Tech Stack:** TypeScript 5.9.3 (ESM, `NodeNext`), Node ≥ 18, Vitest 2.1.9, `@inquirer/core` 9.2.1, chalk 5.6.2.

**Source spec:** `docs/superpowers/specs/2026-08-11-mcp-tui-memory-recall-design.md`, Section 2. Sections 1, 3 and 4 (MCP, memory, recall) get their own plans and are **out of scope here**.

## Global Constraints

- **ESM with explicit extensions.** Every relative import ends in `.js`. Tests import without the extension (`from '../../src/repl/foo'`) — match the existing files.
- **No new dependencies.** This plan needs none. The two approved in the spec belong to the MCP and recall plans.
- **`npm run check`** is the verification command (typecheck of both tsconfigs, tests, build). Single file: `npx vitest run tests/path/file.test.ts`.
- **Ctrl-C keeps meaning quit.** Nothing in this plan may rebind it.
- **Enter submits.** Alt+Enter inserts a newline. Never invert this.
- **What the model receives from tools is unchanged** by Task 5, including existing truncation. Streaming is a display concern only.
- **Commit style:** `feat:` / `fix:` / `refactor:`, lowercase subject.

## File Structure

| File | Responsibility |
|---|---|
| `src/providers/types.ts` (modify) | `Provider.chat` gains an optional `signal` |
| `src/providers/{copilot,ollama,gemini,openrouter}.ts` (modify) | Pass `signal` to their `fetch` |
| `src/providers/chat-error.ts` (modify) | `isAbortError` alongside the existing classifiers |
| `src/agent-loop.ts` (modify) | Catch abort mid-stream, keep the partial reply |
| `src/repl/run-turn.ts` (modify) | `signal` in `TurnOptions`, `aborted` in `TurnResult` |
| `src/repl/interrupt.ts` (create) | Raw-mode Esc listener active only while a reply streams |
| `src/tools/execute.ts` (modify) | `onOutput` streaming for `run_command` |
| `src/repl/line-buffer.ts` (create) | Pure multiline text buffer — insert, newline, cursor |
| `src/repl/slash-prompt.ts` (modify) | Render N lines, Alt+Enter, line-aware up/down |

---

### Task 1: Thread `AbortSignal` to the providers

**Files:**
- Modify: `src/providers/types.ts:30`, `src/providers/copilot.ts:161-175`, `src/providers/ollama.ts:74-80`, `src/providers/gemini.ts:136`, `src/providers/openrouter.ts:52-60`, `src/providers/chat-error.ts`
- Test: `tests/providers/abort.test.ts`

**Interfaces:**
- Produces: `Provider.chat(model, messages, tools?, signal?)`, and `isAbortError(err: unknown): boolean`. Tasks 2–4 depend on both.

**Context:** Each provider owns its own `fetch` call — there is no shared client to change in one place. `openai-compatible.ts` holds shared *parsing*, not the request.

`signal` is optional, so every existing caller and test keeps compiling untouched.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/abort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isAbortError } from '../../src/providers/chat-error';

describe('isAbortError', () => {
  it('recognises the DOMException fetch throws on abort', () => {
    const controller = new AbortController();
    controller.abort();
    const err = new DOMException('This operation was aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('recognises a plain Error named AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('does not mistake an ordinary failure for an abort', () => {
    expect(isAbortError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('aborted')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/providers/abort.test.ts`
Expected: FAIL — `isAbortError` is not exported from `chat-error`.

- [ ] **Step 3: Add the classifier**

Append to `src/providers/chat-error.ts`:

```ts
/**
 * Whether an error is a user-requested cancellation rather than a failure.
 *
 * This distinction decides whether the fallback chain runs. Treating an abort
 * as a provider failure would send the same prompt to a second model
 * immediately after the user asked for it to stop — the opposite of what they
 * pressed Esc for.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
```

`DOMException` extends `Error`, so the one check covers both cases in the test.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/providers/abort.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Widen the Provider interface**

In `src/providers/types.ts`, replace line 30:

```ts
  chat(
    model: string,
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent>;
```

- [ ] **Step 6: Pass the signal in all four providers**

Each has the same two edits: widen the `chat` signature, then add `signal` to its `fetch` options object.

`src/providers/copilot.ts:161`:

```ts
  async *chat(
    model: string,
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent> {
```

and in the `fetch(`${COPILOT_API}/chat/completions`, { … })` options object, add `signal,` alongside `method`, `headers` and `body`.

`src/providers/ollama.ts:74` — identical signature change; add `signal,` to the `fetch(`${BASE_URL}/api/chat`, { … })` options.

`src/providers/openrouter.ts:52` — identical signature change; add `signal,` to the `fetch(`${BASE_URL}/chat/completions`, { … })` options.

`src/providers/gemini.ts:136` — identical signature change; add `signal,` to its `fetch` options.

Do not change `openai-compatible.ts`: it parses the response stream and never issues the request.

- [ ] **Step 7: Verify**

Run: `npm run check`
Expected: all PASS. `signal` is optional, so no existing test or caller needs editing.

- [ ] **Step 8: Commit**

```bash
git add src/providers tests/providers/abort.test.ts
git commit -m "feat: let a chat request carry an AbortSignal"
```

---

### Task 2: Keep the partial reply when a turn is aborted

**Files:**
- Modify: `src/agent-loop.ts:24-52`, `src/repl/run-turn.ts`
- Test: `tests/agent-loop.test.ts` (extend), `tests/repl/run-turn.test.ts` (extend)

**Interfaces:**
- Consumes: `isAbortError` (Task 1).
- Produces: `TurnOptions.signal`, `TurnResult.aborted`. Task 3 consumes both.

**Context and the key decision.** `runAgentTurn` accumulates streamed text in a local `text` and only pushes the assistant message *after* the provider's generator completes (`agent-loop.ts:37-39`). An abort throws out of the `for await`, so the partial reply would be lost.

**Abort is modelled as a normal return, not an error.** `runAgentTurn` catches it, pushes what it has with an `[interrupted]` marker, and returns. `runTurn` therefore never enters its `catch`, so **the fallback chain cannot fire on an abort** — which is the whole point. A user who pressed Esc must not have their prompt immediately re-sent to a different model.

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent-loop.test.ts`:

```ts
describe('runAgentTurn when aborted mid-stream', () => {
  it('keeps the text streamed so far and marks it interrupted', async () => {
    const controller = new AbortController();
    const provider = {
      chat: async function* () {
        yield { type: 'text', text: 'partial ' };
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    } as never;

    const messages = await runAgentTurn(provider, 'm', [], [], {
      onText: () => {},
      executeTool: async () => '',
      confirm: async () => false,
      signal: controller.signal,
    } as never);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('partial ');
    expect(messages[0].content).toContain('[interrupted]');
  });

  it('still throws a genuine failure rather than swallowing it', async () => {
    const provider = {
      chat: async function* () {
        yield { type: 'text', text: 'x' };
        throw new Error('503 Service Unavailable');
      },
    } as never;

    await expect(
      runAgentTurn(provider, 'm', [], [], {
        onText: () => {},
        executeTool: async () => '',
        confirm: async () => false,
      } as never)
    ).rejects.toThrow('503');
  });
});
```

Append to `tests/repl/run-turn.test.ts`:

```ts
it('reports an aborted turn without falling back to another model', async () => {
  const controller = new AbortController();
  const failing = {
    id: 'copilot',
    name: 'GitHub Copilot',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'half an ans' };
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }),
  } as unknown as Provider;
  const rescue = fakeProvider('ollama', 'Ollama (local)', {
    text: 'should never run',
    models: ['llama3.1:latest'],
  });
  const session = createSession(failing, 'gpt-4o');

  const result = await runTurn(
    session,
    'hi',
    options({ providers: [failing, rescue], signal: controller.signal })
  );

  expect(result.aborted).toBe(true);
  expect(rescue.chat).not.toHaveBeenCalled();
  expect(session.history[1].content).toContain('half an ans');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/agent-loop.test.ts tests/repl/run-turn.test.ts`
Expected: FAIL — the abort propagates and the partial reply is lost; `result.aborted` is undefined.

- [ ] **Step 3: Handle abort in the agent loop**

In `src/agent-loop.ts`, add `signal?: AbortSignal;` to `AgentDeps`, import `isAbortError`, pass `deps.signal` to `provider.chat`, and wrap the streaming loop:

```ts
    let text = '';
    const toolCalls: ToolCall[] = [];

    try {
      for await (const event of provider.chat(model, workingHistory, tools, deps.signal)) {
        if (event.type === 'text') {
          text += event.text;
          deps.onText(event.text);
        } else {
          toolCalls.push(event.toolCall);
        }
      }
    } catch (err) {
      // A cancellation is not a failure. Keep what was streamed and return it
      // as a normal result, so the caller's fallback chain never sees it and
      // the user's next message reads as a redirect rather than a non-sequitur.
      if (!isAbortError(err)) throw err;
      newMessages.push({ role: 'assistant', content: `${text}\n\n[interrupted]` });
      return newMessages;
    }
```

- [ ] **Step 4: Surface it on the turn**

In `src/repl/run-turn.ts`, add to `TurnOptions`:

```ts
  /** Aborts the in-flight request. An abort is reported, never retried. */
  signal?: AbortSignal;
```

add to `TurnResult`:

```ts
  /** True when the user interrupted. The partial reply is kept in history. */
  aborted?: boolean;
```

pass `signal: options.signal` into the `runAgentTurn` deps object, and change the success return:

```ts
      session.history.push(...newMessages);
      return {
        ok: true,
        provider: activeProvider,
        model: activeModel,
        aborted: options.signal?.aborted ?? false,
      };
```

No change is needed in the `catch`: an abort now returns normally from `runAgentTurn`, so the fallback path is unreachable for it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-loop.test.ts tests/repl/run-turn.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the whole suite**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent-loop.ts src/repl/run-turn.ts tests/agent-loop.test.ts tests/repl/run-turn.test.ts
git commit -m "feat: keep the partial reply when a turn is interrupted"
```

---

### Task 3: Esc interrupts a streaming reply

**Files:**
- Create: `src/repl/interrupt.ts`
- Modify: `src/repl/run-repl.ts`
- Test: `tests/repl/interrupt.test.ts`

**Interfaces:**
- Consumes: `TurnOptions.signal`, `TurnResult.aborted` (Task 2).
- Produces: `listenForInterrupt(stdin?): { signal: AbortSignal; dispose: () => void }`.

**Context.** The prompt is not active while a reply streams — `readSlashAwareLine` has already resolved. So this needs its own raw-mode keypress listener for the duration of the turn, torn down afterwards.

**Esc is already bound** at `slash-prompt.ts:102`, where it closes the slash popup. The two coexist because they are different modes: that listener only exists while the prompt is accepting input, this one only while a reply streams. They are never live at the same time.

**Non-TTY must be safe.** Under a pipe or in tests there is no raw mode; the function returns a signal that never aborts and a `dispose` that does nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/repl/interrupt.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { listenForInterrupt } from '../../src/repl/interrupt';

function fakeTty() {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (v: boolean) => unknown };
  s.isTTY = true;
  s.setRawMode = vi.fn();
  return s;
}

const settle = () => new Promise((r) => setImmediate(r));

describe('listenForInterrupt', () => {
  it('aborts when Esc is pressed', async () => {
    const stdin = fakeTty();
    const { signal, dispose } = listenForInterrupt(stdin);

    stdin.write('\x1b');
    await settle();

    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('ignores ordinary keys', async () => {
    const stdin = fakeTty();
    const { signal, dispose } = listenForInterrupt(stdin);

    stdin.write('a');
    await settle();

    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('restores raw mode and removes its listener on dispose', async () => {
    const stdin = fakeTty();
    const { signal, dispose } = listenForInterrupt(stdin);
    dispose();

    stdin.write('\x1b');
    await settle();

    expect(signal.aborted).toBe(false);
    expect(stdin.listenerCount('keypress')).toBe(0);
  });

  it('is inert without a TTY, rather than throwing', async () => {
    const stdin = new PassThrough() as never;
    const { signal, dispose } = listenForInterrupt(stdin);

    expect(signal.aborted).toBe(false);
    expect(() => dispose()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/repl/interrupt.test.ts`
Expected: FAIL — cannot resolve `../../src/repl/interrupt`.

- [ ] **Step 3: Write the implementation**

Create `src/repl/interrupt.ts`:

```ts
import * as readline from 'node:readline';

interface Interruptible {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: 'keypress', listener: (str: string, key: { name?: string }) => void): unknown;
  off(event: 'keypress', listener: (str: string, key: { name?: string }) => void): unknown;
}

export interface Interrupt {
  signal: AbortSignal;
  /** Always call this when the turn ends, or the terminal stays in raw mode. */
  dispose: () => void;
}

/**
 * Listens for Esc while a reply is streaming, and aborts the turn.
 *
 * The prompt is not active during a turn — readSlashAwareLine has already
 * resolved — so this owns stdin for the duration and hands it back on dispose.
 *
 * Esc is also bound inside the prompt (slash-prompt.ts, closing the command
 * popup). The two never overlap: that listener exists only while input is
 * being accepted, this one only while a reply streams.
 *
 * Ctrl-C is deliberately untouched and still quits.
 */
export function listenForInterrupt(stdin: Interruptible = process.stdin): Interrupt {
  const controller = new AbortController();

  // Piped input and test harnesses have no raw mode. An inert signal keeps
  // every caller on one code path.
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return { signal: controller.signal, dispose: () => {} };
  }

  readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadableStream);
  stdin.setRawMode(true);

  const onKeypress = (_str: string, key: { name?: string }): void => {
    if (key?.name === 'escape') controller.abort();
  };
  stdin.on('keypress', onKeypress);

  return {
    signal: controller.signal,
    dispose: () => {
      stdin.off('keypress', onKeypress);
      stdin.setRawMode?.(false);
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/repl/interrupt.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use it in the REPL**

In `src/repl/run-repl.ts`, wrap the `runTurn` call. Replace:

```ts
    process.stdout.write(assistantColor('» '));
    const result = await runTurn(session, cmd.arg, {
```

with:

```ts
    process.stdout.write(assistantColor('» '));
    const interrupt = listenForInterrupt();
    const result = await runTurn(session, cmd.arg, {
      signal: interrupt.signal,
```

and immediately after the `runTurn(...)` call resolves, before the `if (result.ok)` branch:

```ts
    interrupt.dispose();
```

`dispose()` must run whether the turn succeeded, failed or aborted — leaving the terminal in raw mode would make the next prompt unusable. Put it on the line directly after the `await`, not inside either branch.

Then, inside the `if (result.ok)` branch, after `process.stdout.write('\n')`:

```ts
      if (result.aborted) {
        console.log(mutedColor('Interrupted. Your next message continues from here.'));
      }
```

Add the import: `import { listenForInterrupt } from './interrupt.js';`

- [ ] **Step 6: Verify**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 7: Manual check**

Raw-mode keypress handling cannot be exercised end to end by the suite.

```bash
npm run build
node dist/cli.js chat ollama    # or any authenticated provider
```

Ask for something long ("write a 500 word essay"), press Esc mid-reply. Expected: the reply stops, `Interrupted.` prints, the prompt returns and accepts input normally. Then confirm Ctrl-C still quits, and that a follow-up message refers to the truncated reply coherently.

- [ ] **Step 8: Commit**

```bash
git add src/repl/interrupt.ts src/repl/run-repl.ts tests/repl/interrupt.test.ts
git commit -m "feat: interrupt a streaming reply with Esc"
```

---

### Task 4: Stream command output live

**Files:**
- Modify: `src/tools/execute.ts:193-236`, `src/repl/run-turn.ts`, `src/repl/run-repl.ts`
- Test: `tests/tools/execute.test.ts` (extend)

**Interfaces:**
- Produces: `ExecuteOptions.onOutput?: (chunk: string) => void`, forwarded through `TurnOptions.onOutput`.

**Context.** `runCommandTool` uses `execAsync` (`execute.ts:216`), which resolves only when the process exits — so a test suite or an install shows a dead terminal until it finishes. Switching to `spawn` gives incremental chunks.

**What the model receives does not change.** Same combined `stdout`+`stderr`, same `MAX_OUTPUT_LENGTH` truncation, same `Exit code:` prefix, same `wrapUntrusted`. Only the human's view is new.

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/execute.test.ts`:

```ts
describe('run_command streaming', () => {
  it('reports output through onOutput before the command exits', async () => {
    const chunks: string[] = [];
    const result = await executeTool(
      {
        id: '1',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'echo streamed-line' }),
      },
      async () => true,
      { onOutput: (c) => chunks.push(c) }
    );

    expect(chunks.join('')).toContain('streamed-line');
    expect(result).toContain('streamed-line');
    expect(result).toContain('Exit code: 0');
  });

  it('still returns the full output when no onOutput is given', async () => {
    const result = await executeTool(
      {
        id: '1',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'echo quiet' }),
      },
      async () => true,
      {}
    );

    expect(result).toContain('quiet');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools/execute.test.ts`
Expected: FAIL — `onOutput` is not part of `ExecuteOptions`, so nothing is collected.

- [ ] **Step 3: Switch to spawn**

In `src/tools/execute.ts`, add to `ExecuteOptions`:

```ts
  /** Receives stdout/stderr chunks as they arrive, for live display. */
  onOutput?: (chunk: string) => void;
```

`runCommandTool` currently takes discrete parameters (`command`, `confirm`, `timeoutMs`, `onAutoApproved`) rather than an options object. Add a fifth:

```ts
async function runCommandTool(
  command: string,
  confirm: ConfirmFn,
  timeoutMs: number,
  onAutoApproved?: (command: string) => void,
  onOutput?: (chunk: string) => void
): Promise<string> {
```

and pass `options.onOutput` at the call site in the `executeTool` switch (`execute.ts:110`), next to the existing `options.onAutoApproved`.

Then replace the `execAsync` block with a `spawn`-based one. Keep the approval logic above it exactly as-is:

```ts
  return await new Promise<string>((resolve) => {
    const child = spawn(command, { shell: true });
    let output = '';
    let timedOut = false;

    // Without a timeout a command that waits on stdin (which it never gets —
    // the REPL owns it) hangs the whole session with no way back to the prompt.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      // Cap what is retained, but keep streaming to the display — the human
      // watching a long build still wants to see it finish.
      if (output.length < MAX_OUTPUT_LENGTH) output += text;
      onOutput?.(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Error: ${err.message}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(`Error: command timed out after ${timeoutMs / 1000}s and was terminated.`);
        return;
      }
      const truncated = output.slice(0, MAX_OUTPUT_LENGTH);
      resolve(`Exit code: ${code ?? 1}\n${wrapUntrusted(`output of "${command}"`, truncated)}`);
    });
  });
```

Add `import { spawn } from 'node:child_process';` and drop the now-unused `execAsync`/`promisify` imports if nothing else uses them — let the typecheck confirm.

`shell: true` preserves current behaviour: `execAsync` also ran through a shell, and `environment-prompt.ts` already tells the model which shell that is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools/execute.test.ts tests/tools/execute-hardening.test.ts`
Expected: PASS. The hardening suite must pass **unchanged** — the approval gate and sensitive-path checks sit above this code and are untouched.

- [ ] **Step 5: Wire it to the terminal**

In `src/repl/run-turn.ts`, add to `TurnOptions`:

```ts
  /** Live command output, for display only. */
  onOutput?: (chunk: string) => void;
```

and pass it into the `executeTool` call alongside `onAutoApproved`.

In `src/repl/run-repl.ts`, add to the `runTurn` options:

```ts
      onOutput: (chunk) => process.stdout.write(mutedColor(chunk)),
```

- [ ] **Step 6: Verify**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 7: Manual check**

```bash
npm run build
node dist/cli.js chat ollama
```

Ask it to run something slow — "run `npm test`". Expected: output appears progressively in dim text rather than arriving in one block at the end.

- [ ] **Step 8: Commit**

```bash
git add src/tools/execute.ts src/repl/run-turn.ts src/repl/run-repl.ts tests/tools/execute.test.ts
git commit -m "feat: stream command output as it arrives"
```

---

### Task 5: A multiline line buffer

**Files:**
- Create: `src/repl/line-buffer.ts`
- Test: `tests/repl/line-buffer.test.ts`

**Interfaces:**
- Produces: `LineBuffer` with `insert`, `newline`, `backspace`, `moveLeft`, `moveRight`, `moveUp`, `moveDown`, `text`, `lines`, `cursorLine`, `cursorColumn`, `atFirstLine`, `atLastLine`, `setText`. Task 6 renders it.

**Context.** Pure and I/O-free, so the fiddly parts are unit-testable without a terminal. `slash-prompt.ts` currently mirrors readline's own single-line buffer (`slash-prompt.ts:126`); Task 6 replaces that with this.

Cursor is a single offset into the text; line and column are derived. One source of truth avoids the classic bug where they drift apart.

- [ ] **Step 1: Write the failing test**

Create `tests/repl/line-buffer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LineBuffer } from '../../src/repl/line-buffer';

describe('LineBuffer', () => {
  it('starts empty with the cursor at the origin', () => {
    const b = new LineBuffer();
    expect(b.text).toBe('');
    expect(b.lines).toEqual(['']);
    expect(b.cursorLine).toBe(0);
    expect(b.cursorColumn).toBe(0);
  });

  it('inserts characters at the cursor', () => {
    const b = new LineBuffer();
    b.insert('ab');
    b.insert('c');
    expect(b.text).toBe('abc');
    expect(b.cursorColumn).toBe(3);
  });

  it('splits into lines on newline', () => {
    const b = new LineBuffer();
    b.insert('one');
    b.newline();
    b.insert('two');
    expect(b.lines).toEqual(['one', 'two']);
    expect(b.cursorLine).toBe(1);
    expect(b.cursorColumn).toBe(3);
  });

  it('inserts in the middle rather than appending', () => {
    const b = new LineBuffer();
    b.insert('ac');
    b.moveLeft();
    b.insert('b');
    expect(b.text).toBe('abc');
  });

  it('backspace joins two lines when at the start of one', () => {
    const b = new LineBuffer();
    b.insert('one');
    b.newline();
    b.backspace();
    expect(b.lines).toEqual(['one']);
    expect(b.cursorColumn).toBe(3);
  });

  it('moveUp keeps the column where the line is long enough', () => {
    const b = new LineBuffer();
    b.insert('long line');
    b.newline();
    b.insert('also long');
    b.moveUp();
    expect(b.cursorLine).toBe(0);
    expect(b.cursorColumn).toBe(9);
  });

  it('moveUp clamps the column on a shorter line', () => {
    const b = new LineBuffer();
    b.insert('ab');
    b.newline();
    b.insert('long line');
    b.moveUp();
    expect(b.cursorLine).toBe(0);
    expect(b.cursorColumn).toBe(2);
  });

  it('reports whether the cursor is on the first or last line', () => {
    const b = new LineBuffer();
    b.insert('one');
    expect(b.atFirstLine).toBe(true);
    expect(b.atLastLine).toBe(true);

    b.newline();
    b.insert('two');
    expect(b.atFirstLine).toBe(false);
    expect(b.atLastLine).toBe(true);

    b.moveUp();
    expect(b.atFirstLine).toBe(true);
    expect(b.atLastLine).toBe(false);
  });

  it('setText replaces everything and parks the cursor at the end', () => {
    const b = new LineBuffer();
    b.insert('old');
    b.setText('new\ntext');
    expect(b.lines).toEqual(['new', 'text']);
    expect(b.cursorLine).toBe(1);
    expect(b.cursorColumn).toBe(4);
  });

  it('does not move past either end', () => {
    const b = new LineBuffer();
    b.moveLeft();
    b.moveUp();
    expect(b.cursorColumn).toBe(0);
    b.insert('x');
    b.moveRight();
    b.moveDown();
    expect(b.cursorColumn).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/repl/line-buffer.test.ts`
Expected: FAIL — cannot resolve `../../src/repl/line-buffer`.

- [ ] **Step 3: Write the implementation**

Create `src/repl/line-buffer.ts`:

```ts
/**
 * A multiline text buffer with a cursor. Pure — no terminal, no I/O.
 *
 * The cursor is one offset into `value`; line and column are derived from it.
 * Storing all three lets them drift apart, which is the usual source of
 * off-by-one bugs in editors like this.
 */
export class LineBuffer {
  private value = '';
  private offset = 0;

  get text(): string {
    return this.value;
  }

  get lines(): string[] {
    return this.value.split('\n');
  }

  get cursorLine(): number {
    return this.value.slice(0, this.offset).split('\n').length - 1;
  }

  get cursorColumn(): number {
    const before = this.value.slice(0, this.offset);
    return before.length - (before.lastIndexOf('\n') + 1);
  }

  get atFirstLine(): boolean {
    return this.cursorLine === 0;
  }

  get atLastLine(): boolean {
    return this.cursorLine === this.lines.length - 1;
  }

  get isEmpty(): boolean {
    return this.value.length === 0;
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.offset) + text + this.value.slice(this.offset);
    this.offset += text.length;
  }

  newline(): void {
    this.insert('\n');
  }

  backspace(): void {
    if (this.offset === 0) return;
    this.value = this.value.slice(0, this.offset - 1) + this.value.slice(this.offset);
    this.offset -= 1;
  }

  moveLeft(): void {
    if (this.offset > 0) this.offset -= 1;
  }

  moveRight(): void {
    if (this.offset < this.value.length) this.offset += 1;
  }

  /** No-op on the first line, so the caller can fall through to input history. */
  moveUp(): void {
    if (this.atFirstLine) return;
    this.moveToLine(this.cursorLine - 1, this.cursorColumn);
  }

  /** No-op on the last line, so the caller can fall through to input history. */
  moveDown(): void {
    if (this.atLastLine) return;
    this.moveToLine(this.cursorLine + 1, this.cursorColumn);
  }

  setText(text: string): void {
    this.value = text;
    this.offset = text.length;
  }

  clear(): void {
    this.setText('');
  }

  /** Column is clamped, so moving onto a shorter line lands at its end. */
  private moveToLine(line: number, column: number): void {
    const lines = this.lines;
    let start = 0;
    for (let i = 0; i < line; i++) start += lines[i].length + 1;
    this.offset = start + Math.min(column, lines[line].length);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/repl/line-buffer.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/repl/line-buffer.ts tests/repl/line-buffer.test.ts
git commit -m "feat: add a pure multiline line buffer"
```

---

### Task 6: Multiline editing at the prompt

**Files:**
- Modify: `src/repl/slash-prompt.ts`
- Test: `tests/repl/slash-prompt.test.ts` (extend)

**Interfaces:**
- Consumes: `LineBuffer` (Task 5).

**Context.** `promptWithSlashMenu` mirrors readline's buffer into `value` and renders one line (`slash-prompt.ts:126`). It now owns a `LineBuffer` instead and renders every line.

**Three behaviours must not change**, and each has existing tests that must keep passing untouched:

1. **Enter submits** (`slash-prompt.ts:104-117`), including submitting the highlighted popup entry when the popup is open.
2. **Up/down move the popup selection while the popup is open** (`:63-70`).
3. **With the popup closed, up/down walk input history**, stashing the draft (`:71-87`).

Rule three gains one qualifier: inside a multiline buffer, up/down move between *lines* first, and only reach history from the first or last line. Without that, editing line two of a paragraph would silently replace the whole thing with a history entry.

- [ ] **Step 1: Write the failing tests**

Append to `tests/repl/slash-prompt.test.ts`, using the existing `fakeTerminal()` harness:

```ts
describe('multiline input', () => {
  it('submits on Enter as before', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('one line\r');
    expect(await answer).toBe('one line');
  });

  it('inserts a newline on Alt+Enter instead of submitting', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('first');
    term.input.write('\x1b\r'); // Alt+Enter
    await term.settle();
    await term.type('second\r');
    expect(await answer).toBe('first\nsecond');
  });

  it('continues onto the next line after a trailing backslash', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('first\\\r');
    await term.type('second\r');
    expect(await answer).toBe('first\nsecond');
  });

  it('up moves between lines before reaching input history', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['an older command'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await term.type('first');
    term.input.write('\x1b\r');
    await term.settle();
    await term.type('second');

    term.input.write('\x1b[A'); // up: to line one, NOT history
    await term.settle();
    term.input.write('\r');

    expect(await answer).toBe('first\nsecond');
  });

  it('reaches input history from the first line', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['an older command'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    term.input.write('\x1b[A');
    await term.settle();
    term.input.write('\r');

    expect(await answer).toBe('an older command');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/repl/slash-prompt.test.ts`
Expected: the Enter test passes; the four multiline tests FAIL.

- [ ] **Step 3: Rewrite the prompt around `LineBuffer`**

In `src/repl/slash-prompt.ts`:

Replace `const [value, setValue] = useState('')` with a buffer held across renders:

```ts
  const [buffer] = useState(() => new LineBuffer());
  const [version, setVersion] = useState(0);
  // LineBuffer mutates in place, so bump a counter to force a re-render.
  const redraw = () => setVersion(version + 1);
```

The keypress handler becomes, in order:

```ts
    // 1. Popup open: up/down move the selection. Unchanged.
    if (key.name === 'up' && matches.length > 0) { /* existing */ }
    if (key.name === 'down' && matches.length > 0) { /* existing */ }

    // 2. Alt+Enter inserts a newline. `key.meta` is how the terminal reports
    //    the Alt modifier; Shift+Enter is indistinguishable from Enter on many
    //    terminals, which is why Alt is the documented binding.
    if (isEnterKey(key) && key.meta) {
      buffer.newline();
      redraw();
      return;
    }

    // 3. A trailing backslash continues the line, for terminals that swallow
    //    Alt+Enter entirely.
    if (isEnterKey(key) && buffer.text.endsWith('\\')) {
      buffer.backspace();
      buffer.newline();
      redraw();
      return;
    }

    // 4. Enter submits. readline clears its own buffer before this listener
    //    runs, so submit the buffer we own, never rl.line.
    if (isEnterKey(key)) {
      done(matches.length > 0 ? matches[selected].name : buffer.text);
      return;
    }

    // 5. Up/down: move within the buffer first, fall through to history only
    //    at the edges.
    if (key.name === 'up') {
      if (!buffer.atFirstLine) { buffer.moveUp(); redraw(); return; }
      /* existing history-recall branch, but writing through buffer.setText */
    }
    if (key.name === 'down') {
      if (!buffer.atLastLine) { buffer.moveDown(); redraw(); return; }
      /* existing history-recall branch, but writing through buffer.setText */
    }
```

The existing `replaceBuffer` helper becomes:

```ts
    const replaceBuffer = (text: string) => {
      buffer.setText(text);
      setMatches([]);
      setSelected(0);
      redraw();
    };
```

Note it no longer touches `rl` — the buffer is now the single source of truth. Keep the comment explaining why a history write must not re-run the slash filter (`slash-prompt.ts:51-54`); that hazard is unchanged.

Left/right arrows call `buffer.moveLeft()` / `moveRight()`; backspace calls `buffer.backspace()`; any other printable key calls `buffer.insert(str)`.

Rendering: the top section becomes every line, with `> ` on the first and two spaces of indent on the rest, so continuation lines align:

```ts
  const rendered = buffer.lines
    .map((line, i) => (i === 0 ? `${USER_INPUT_COLOR}> ${line}` : `  ${line}`))
    .join('\n');
  const top = `${rendered}${RESET_COLOR}`;
```

The slash filter runs on the **first line only** — `filterSlashCommands(buffer.lines[0])` — since a command is never spread across lines.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/repl/slash-prompt.test.ts`
Expected: PASS, including every pre-existing test **unchanged**. If an existing test needs editing, one of the three preserved behaviours has been broken — fix the source, not the test.

- [ ] **Step 5: Verify the whole suite**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 6: Manual check**

Multiline *rendering* is not covered by the suite.

```bash
npm run build
node dist/cli.js chat ollama
```

Check: Alt+Enter starts a second line and the prompt grows; arrow keys move within the paragraph; up from line one recalls history; `/` still opens the popup and Tab still completes; a recalled multi-line entry renders across lines.

- [ ] **Step 7: Update the README**

Add a short "Editing" note near the command list: Enter submits, Alt+Enter (or a trailing `\`) starts a new line, Esc interrupts a streaming reply, Ctrl-C quits.

- [ ] **Step 8: Commit**

```bash
git add src/repl/slash-prompt.ts tests/repl/slash-prompt.test.ts README.md
git commit -m "feat: multiline editing at the prompt"
```

---

## Self-Review

**Spec coverage.** Section 2's three pieces map to: multiline → Tasks 5–6; interrupt-and-redirect → Tasks 1–3; streaming tool output → Task 4. The spec's Esc-coexistence rule is enforced in Task 3 Step 3 and the Task 6 preserved-behaviours list. Enter-submits and Ctrl-C-quits appear in Global Constraints. Sections 1, 3 and 4 are explicitly out of scope.

**The ordering claim this plan rests on.** Tasks 1–3 exist first because `runTurn` has one caller today. If the sessions, `/compare` or workflow plans land before this, Task 1 grows from four signature changes to four plus every new call site, and Task 2 has to define what abort means with concurrent streams. That is the argument for doing this batch first, and it expires.

**Known gaps, stated rather than hidden:**

- **Three manual checks** (Tasks 3, 4, 6). Raw-mode keypresses, live output rendering and multiline drawing all sit past what the fake-TTY harness reaches. The Esc one matters most — it is the only proof that `dispose()` actually restores the terminal.
- **`key.meta` for Alt+Enter is terminal-dependent.** The trailing-backslash continuation exists precisely because some terminals will not deliver it. If Alt+Enter proves unreliable in practice, the fallback still works and the README documents both.
- **Task 4 changes `execAsync` to `spawn`**, which alters error shapes. `tests/tools/execute-hardening.test.ts` must pass unchanged; if it does not, the approval path has been disturbed and that is a real regression, not a test to update.
- **No test covers Ctrl-C still quitting.** It is verified by not being touched, and by the manual check in Task 3.
