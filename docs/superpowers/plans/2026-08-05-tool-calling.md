# Tool-Calling Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `ai-term-chat` tool-calling so the model can read files, write files, and run shell commands, with y/n confirmation before any write or command execution.

**Architecture:** `Provider.chat()` changes from yielding raw text strings to yielding typed `ChatEvent`s (`text` | `tool_call`), and gains an optional `tools` parameter. A new `runAgentTurn` function drives the round-trip loop: call the model, execute any requested tools (with confirmation), feed results back, repeat until the model stops calling tools or a 10-round cap is hit. Wired into both providers and the REPL.

**Tech Stack:** Same as the existing project — Node.js >= 18, TypeScript (strict), `vitest`. No new dependencies.

## Global Constraints

- `Provider.chat()`'s return type changes from `AsyncIterable<string>` to `AsyncIterable<ChatEvent>` — a breaking interface change; every implementer and consumer is updated in the same task.
- Agent loop is capped at **10 rounds** of tool-calling per user turn.
- `write_file` confirmation preview is truncated to the first **500 characters** of content.
- `run_command` output (stdout+stderr combined) is truncated to **4000 characters**.
- Confirmation accepts `y` or `yes` (case-insensitive) as approval; anything else is a decline.
- No test may hit real GitHub/Ollama/Copilot network endpoints — `global.fetch` stays mocked. `run_command` tests may execute real, harmless, cross-platform commands (e.g. `node -e "..."`, since Node is already a project dependency).
- Tools are always available in every chat session — no opt-in flag.

---

### Task 1: Provider event refactor (Checkpoint 1)

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/ollama.ts`
- Modify: `src/providers/copilot.ts`
- Modify: `src/repl/run-repl.ts`
- Modify: `tests/providers/ollama.test.ts`
- Modify: `tests/providers/copilot.test.ts`

**Interfaces:**
- Produces: `ToolCall { id, name, arguments }`, `ToolDefinition { name, description, parameters }`, `ChatEvent = { type: 'text'; text: string } | { type: 'tool_call'; toolCall: ToolCall }`, updated `Message` (adds optional `toolCalls?: ToolCall[]`, `toolCallId?: string`, and `'tool'` as a valid `role`), updated `Provider.chat(model, messages, tools?): AsyncIterable<ChatEvent>`. Tasks 2–5 depend on these types.
- No tool-calling behavior yet — this task only changes the event shape; providers ignore the new `tools` parameter for now (added properly in Tasks 4–5).

- [ ] **Step 1: Update `src/providers/types.ts`**

```ts
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded arguments string
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema for the tool's arguments
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall };

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface Provider {
  id: string;
  name: string;
  isAuthenticated(): Promise<boolean>;
  login(): Promise<void>;
  listModels(): Promise<string[]>;
  chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent>;
  logout(): Promise<void>;
}
```

- [ ] **Step 2: Update `src/providers/ollama.ts`'s `chat` method to yield `ChatEvent`s**

Replace the existing `chat` method with:

```ts
async *chat(model: string, messages: Message[], _tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat request failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) yield { type: 'text', text: parsed.message.content };
      }
    }
  }
```

Update the import line at the top of the file to:

```ts
import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
```

- [ ] **Step 3: Update `tests/providers/ollama.test.ts`'s streaming test for the new event shape**

Replace the `'chat yields streamed content chunks'` test body with:

```ts
  it('chat yields streamed text events', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Hel' } }) + '\n',
      JSON.stringify({ message: { content: 'lo' } }) + '\n',
      JSON.stringify({ done: true }) + '\n',
    ];
    let i = 0;
    const encoder = new TextEncoder();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < lines.length) {
              return { done: false, value: encoder.encode(lines[i++]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    }) as unknown as typeof fetch;

    const events: { type: string; text?: string }[] = [];
    for await (const event of provider.chat('llama3', [{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
  });
```

- [ ] **Step 4: Run Ollama tests to verify they pass**

Run: `npm test -- ollama`
Expected: 5 passed.

- [ ] **Step 5: Update `src/providers/copilot.ts`'s `chat` method to yield `ChatEvent`s**

Replace the existing `chat` method with:

```ts
async *chat(model: string, messages: Message[], _tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    const token = await this.getCopilotToken();
    const res = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Copilot chat request failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '[DONE]') return;
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield { type: 'text', text: content };
      }
    }
  }
```

Update the import line at the top of the file to:

```ts
import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
```

- [ ] **Step 6: Update `tests/providers/copilot.test.ts`'s SSE streaming test for the new event shape**

Replace the `'chat streams content deltas parsed from SSE'` test's assertion section (keep the fetch mock setup the same) with:

```ts
    const events: { type: string; text?: string }[] = [];
    for await (const event of provider.chat('gpt-4o', [{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'text', text: ' there' },
    ]);
```

- [ ] **Step 7: Run Copilot tests to verify they pass**

Run: `npm test -- copilot`
Expected: 5 passed.

- [ ] **Step 8: Update `src/repl/run-repl.ts` to consume `ChatEvent`s instead of raw strings**

Replace the message-handling block (from `if (!cmd.arg) continue;` to the end of the `try/catch`) with:

```ts
    if (!cmd.arg) continue;

    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(chalk.magenta('assistant> '));
    let reply = '';
    try {
      for await (const event of provider.chat(model, history)) {
        if (event.type === 'text') {
          process.stdout.write(event.text);
          reply += event.text;
        }
      }
      process.stdout.write('\n');
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      console.log(chalk.red(`\nError: ${(err as Error).message}`));
    }
```

- [ ] **Step 9: Build and run the full test suite**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `npm test`
Expected: all tests pass (still 28 tests — no new tests added in this task).

- [ ] **Step 10: Manual regression check**

Run `node dist/cli.js chat ollama` (or `chat copilot`), send a message, confirm streamed text still appears exactly as before this change. This is a pure regression check — no new capability yet.

- [ ] **Step 11: Commit**

```bash
git add src/providers/types.ts src/providers/ollama.ts src/providers/copilot.ts src/repl/run-repl.ts tests/providers/ollama.test.ts tests/providers/copilot.test.ts
git commit -m "refactor: change Provider.chat to yield typed ChatEvents"
```

---

### Task 2: Tool definitions and execution (Checkpoint 2, part 1)

**Files:**
- Create: `src/tools/definitions.ts`
- Create: `src/tools/execute.ts`
- Test: `tests/tools/execute.test.ts`

**Interfaces:**
- Consumes: `ToolCall`, `ToolDefinition` from `src/providers/types.ts` (Task 1).
- Produces: `TOOL_DEFINITIONS: ToolDefinition[]` (the three tools). `ConfirmFn = (message: string) => Promise<boolean>` and `executeTool(toolCall: ToolCall, confirm: ConfirmFn): Promise<string>`. Task 3 (agent loop) and Tasks 4–5 (REPL wiring) depend on these exact names and signatures.

- [ ] **Step 1: Write `src/tools/definitions.ts`**

```ts
import type { ToolDefinition } from '../providers/types.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file at the given path, creating it or overwriting it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write.' },
        content: { type: 'string', description: 'Content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return its output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['command'],
    },
  },
];
```

- [ ] **Step 2: Write the failing tests for `src/tools/execute.ts`**

`tests/tools/execute.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeTool } from '../../src/tools/execute';
import type { ToolCall } from '../../src/providers/types';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call-1', name, arguments: JSON.stringify(args) };
}

describe('executeTool', () => {
  it('read_file returns file contents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const filePath = path.join(dir, 'a.txt');
    await fs.writeFile(filePath, 'hello world');
    const result = await executeTool(call('read_file', { path: filePath }), async () => true);
    expect(result).toBe('hello world');
  });

  it('read_file returns an error message for a missing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const result = await executeTool(
      call('read_file', { path: path.join(dir, 'missing.txt') }),
      async () => true
    );
    expect(result).toMatch(/^Error:/);
  });

  it('write_file writes the file when confirmed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const filePath = path.join(dir, 'b.txt');
    const result = await executeTool(
      call('write_file', { path: filePath, content: 'hi there' }),
      async () => true
    );
    expect(result).toMatch(/^Wrote \d+ bytes/);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('hi there');
  });

  it('write_file does not write when declined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'));
    const filePath = path.join(dir, 'c.txt');
    const result = await executeTool(
      call('write_file', { path: filePath, content: 'nope' }),
      async () => false
    );
    expect(result).toBe(`Write to ${filePath} was declined by the user.`);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('run_command executes and returns output when confirmed', async () => {
    const result = await executeTool(
      call('run_command', { command: 'node -e "console.log(1+1)"' }),
      async () => true
    );
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('2');
  });

  it('run_command does not execute when declined', async () => {
    const result = await executeTool(
      call('run_command', { command: 'node -e "process.exit(1)"' }),
      async () => false
    );
    expect(result).toBe('Command "node -e "process.exit(1)"" was declined by the user.');
  });

  it('returns an error message for an unknown tool name', async () => {
    const result = await executeTool(call('bogus_tool', {}), async () => true);
    expect(result).toMatch(/unknown tool/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tools/execute`
Expected: FAIL — `src/tools/execute.ts` does not exist.

- [ ] **Step 4: Implement `src/tools/execute.ts`**

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolCall } from '../providers/types.js';

const execAsync = promisify(exec);
const MAX_OUTPUT_LENGTH = 4000;
const MAX_PREVIEW_LENGTH = 500;

export type ConfirmFn = (message: string) => Promise<boolean>;

export async function executeTool(toolCall: ToolCall, confirm: ConfirmFn): Promise<string> {
  const args = JSON.parse(toolCall.arguments) as Record<string, unknown>;

  switch (toolCall.name) {
    case 'read_file':
      return readFileTool(args.path as string);
    case 'write_file':
      return writeFileTool(args.path as string, args.content as string, confirm);
    case 'run_command':
      return runCommandTool(args.command as string, confirm);
    default:
      return `Error: unknown tool "${toolCall.name}".`;
  }
}

async function readFileTool(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

async function writeFileTool(filePath: string, content: string, confirm: ConfirmFn): Promise<string> {
  const preview = content.length > MAX_PREVIEW_LENGTH ? `${content.slice(0, MAX_PREVIEW_LENGTH)}...` : content;
  const approved = await confirm(`Write to ${filePath}?\n---\n${preview}\n---`);
  if (!approved) {
    return `Write to ${filePath} was declined by the user.`;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${filePath}.`;
}

async function runCommandTool(command: string, confirm: ConfirmFn): Promise<string> {
  const approved = await confirm(`Run "${command}"?`);
  if (!approved) {
    return `Command "${command}" was declined by the user.`;
  }
  try {
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 });
    const output = `${stdout}${stderr}`.slice(0, MAX_OUTPUT_LENGTH);
    return `Exit code: 0\n${output}`;
  } catch (err) {
    const execErr = err as { code?: number; stdout?: string; stderr?: string; message: string };
    const output = (`${execErr.stdout ?? ''}${execErr.stderr ?? ''}`.slice(0, MAX_OUTPUT_LENGTH)) || execErr.message;
    return `Exit code: ${execErr.code ?? 1}\n${output}`;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tools/execute`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add src/tools/definitions.ts src/tools/execute.ts tests/tools/execute.test.ts
git commit -m "feat: add read_file, write_file, run_command tools with confirmation"
```

---

### Task 3: Agent loop (Checkpoint 2, part 2)

**Files:**
- Create: `src/agent-loop.ts`
- Test: `tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: `Provider`, `Message`, `ToolCall`, `ToolDefinition`, `ChatEvent` from `src/providers/types.ts` (Task 1); `ConfirmFn` shape matches `src/tools/execute.ts`'s (Task 2) but is defined independently here to keep `agent-loop.ts` decoupled from the tools module.
- Produces: `AgentDeps { confirm: ConfirmFn; executeTool: (toolCall: ToolCall, confirm: ConfirmFn) => Promise<string>; onText: (text: string) => void }` and `runAgentTurn(provider: Provider, model: string, history: Message[], tools: ToolDefinition[], deps: AgentDeps): Promise<Message[]>`. Tasks 4–5 wire this into the REPL, passing `executeTool` from `src/tools/execute.ts` and `TOOL_DEFINITIONS` from `src/tools/definitions.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/agent-loop.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Provider, ChatEvent, ToolCall } from '../src/providers/types';
import { runAgentTurn } from '../src/agent-loop';

function fakeProvider(responses: ChatEvent[][]): Provider {
  let call = 0;
  const chat = async function* (): AsyncIterable<ChatEvent> {
    const events = responses[call] ?? [];
    call += 1;
    for (const event of events) yield event;
  };
  return {
    id: 'fake',
    name: 'Fake',
    isAuthenticated: vi.fn(),
    login: vi.fn(),
    listModels: vi.fn(),
    logout: vi.fn(),
    chat,
  } as unknown as Provider;
}

describe('runAgentTurn', () => {
  it('returns a single assistant message when there are no tool calls', async () => {
    const provider = fakeProvider([[{ type: 'text', text: 'Hello there' }]]);
    const onText = vi.fn();
    const result = await runAgentTurn(provider, 'model', [], [], {
      confirm: async () => true,
      executeTool: vi.fn(),
      onText,
    });
    expect(result).toEqual([{ role: 'assistant', content: 'Hello there' }]);
    expect(onText).toHaveBeenCalledWith('Hello there');
  });

  it('executes a tool call, feeds the result back, and returns the final text', async () => {
    const toolCall: ToolCall = { id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' };
    const provider = fakeProvider([
      [{ type: 'tool_call', toolCall }],
      [{ type: 'text', text: 'The file says hi.' }],
    ]);
    const executeTool = vi.fn().mockResolvedValue('hi');
    const result = await runAgentTurn(provider, 'model', [], [], {
      confirm: async () => true,
      executeTool,
      onText: vi.fn(),
    });
    expect(executeTool).toHaveBeenCalledWith(toolCall, expect.any(Function));
    expect(result).toEqual([
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', content: 'hi', toolCallId: 'call-1' },
      { role: 'assistant', content: 'The file says hi.' },
    ]);
  });

  it('stops after the maximum number of rounds', async () => {
    const toolCall: ToolCall = { id: 'call-1', name: 'run_command', arguments: '{"command":"x"}' };
    const responses: ChatEvent[][] = Array.from({ length: 15 }, () => [{ type: 'tool_call', toolCall }]);
    const provider = fakeProvider(responses);
    const result = await runAgentTurn(provider, 'model', [], [], {
      confirm: async () => true,
      executeTool: vi.fn().mockResolvedValue('ok'),
      onText: vi.fn(),
    });
    const last = result[result.length - 1];
    expect(last.content).toMatch(/maximum number of tool-call rounds/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent-loop`
Expected: FAIL — `src/agent-loop.ts` does not exist.

- [ ] **Step 3: Implement `src/agent-loop.ts`**

```ts
import type { Provider, Message, ToolCall, ToolDefinition } from './providers/types.js';

export type ConfirmFn = (message: string) => Promise<boolean>;

export interface AgentDeps {
  confirm: ConfirmFn;
  executeTool: (toolCall: ToolCall, confirm: ConfirmFn) => Promise<string>;
  onText: (text: string) => void;
}

const MAX_ROUNDS = 10;

export async function runAgentTurn(
  provider: Provider,
  model: string,
  history: Message[],
  tools: ToolDefinition[],
  deps: AgentDeps
): Promise<Message[]> {
  const newMessages: Message[] = [];
  let workingHistory = [...history];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = '';
    const toolCalls: ToolCall[] = [];

    for await (const event of provider.chat(model, workingHistory, tools)) {
      if (event.type === 'text') {
        text += event.text;
        deps.onText(event.text);
      } else {
        toolCalls.push(event.toolCall);
      }
    }

    const assistantMessage: Message = { role: 'assistant', content: text };
    if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
    newMessages.push(assistantMessage);
    workingHistory = [...workingHistory, assistantMessage];

    if (toolCalls.length === 0) {
      return newMessages;
    }

    for (const toolCall of toolCalls) {
      const result = await deps.executeTool(toolCall, deps.confirm);
      const toolMessage: Message = { role: 'tool', content: result, toolCallId: toolCall.id };
      newMessages.push(toolMessage);
      workingHistory = [...workingHistory, toolMessage];
    }
  }

  const limitMessage: Message = {
    role: 'assistant',
    content: 'Stopped after reaching the maximum number of tool-call rounds (10).',
  };
  newMessages.push(limitMessage);
  return newMessages;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent-loop`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/agent-loop.ts tests/agent-loop.test.ts
git commit -m "feat: add agent loop for tool-calling round-trips"
```

---

### Task 4: Wire tools into Ollama and the REPL (Checkpoint 3)

**Files:**
- Modify: `src/providers/ollama.ts`
- Modify: `tests/providers/ollama.test.ts`
- Modify: `src/repl/run-repl.ts`

**Interfaces:**
- Consumes: `runAgentTurn`, `AgentDeps` from `src/agent-loop.ts` (Task 3); `executeTool` from `src/tools/execute.ts` (Task 2); `TOOL_DEFINITIONS` from `src/tools/definitions.ts` (Task 2).
- Produces: `OllamaProvider.chat()` now emits `tool_call` events when `tools` is passed and the model requests one. `run-repl.ts`'s message-handling now goes through `runAgentTurn` instead of directly iterating `provider.chat()`.

- [ ] **Step 1: Write the failing test for Ollama's tool-call path**

Add to `tests/providers/ollama.test.ts`:

```ts
  it('chat with tools uses a non-streaming request and yields tool_call events', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
      }),
    }) as unknown as typeof fetch;

    const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
    const events = [];
    for await (const event of provider.chat('llama3.1', [{ role: 'user', content: 'read a.txt' }], tools)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'tool_call', toolCall: { id: 'ollama-call-0', name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ollama`
Expected: FAIL — the current `chat` implementation ignores `tools` and always streams, so the mocked non-streaming `json()` response path is never hit and the assertion fails.

- [ ] **Step 3: Update `src/providers/ollama.ts` to support tools**

Replace the `chat` method with:

```ts
async *chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    if (tools && tools.length > 0) {
      yield* this.chatWithTools(model, messages, tools);
      return;
    }
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat request failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) yield { type: 'text', text: parsed.message.content };
      }
    }
  }

  private async *chatWithTools(
    model: string,
    messages: Message[],
    tools: ToolDefinition[]
  ): AsyncIterable<ChatEvent> {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    });
    if (!res.ok) throw new Error(`Ollama chat request failed: ${res.status}`);
    const data = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
      };
    };
    if (data.message?.content) yield { type: 'text', text: data.message.content };
    const toolCalls = data.message?.tool_calls ?? [];
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      yield {
        type: 'tool_call',
        toolCall: {
          id: `ollama-call-${i}`,
          name: call.function.name,
          arguments: JSON.stringify(call.function.arguments),
        },
      };
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- ollama`
Expected: 6 passed.

- [ ] **Step 5: Wire `runAgentTurn` into `src/repl/run-repl.ts`**

Update the imports at the top of `src/repl/run-repl.ts`:

```ts
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Provider, Message } from '../providers/types.js';
import { parseCommand } from './parse-command.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
```

Replace the message-handling block (from `if (!cmd.arg) continue;` to the end of the `try/catch`) with:

```ts
    if (!cmd.arg) continue;

    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(chalk.magenta('assistant> '));
    try {
      const newMessages = await runAgentTurn(provider, model, history, TOOL_DEFINITIONS, {
        onText: (text) => process.stdout.write(text),
        executeTool,
        confirm: async (message) => {
          const answer = await rl.question(chalk.yellow(`\n${message} (y/n) `));
          return /^y(es)?$/i.test(answer.trim());
        },
      });
      history.push(...newMessages);
      process.stdout.write('\n');
    } catch (err) {
      console.log(chalk.red(`\nError: ${(err as Error).message}`));
    }
```

- [ ] **Step 6: Build and run the full test suite**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Manual check — live tool-calling with Ollama**

If Ollama is installed with a tool-capable model (e.g. `ollama pull llama3.1`): run `node dist/cli.js chat ollama`, pick `llama3.1`, and try prompts like:
- "Create a file called hello.txt in the current directory with the content 'hi from the agent'." — confirm the y/n prompt appears, approve it, and verify `hello.txt` was created with that content.
- "Run the command `echo test` and tell me what it printed." — confirm the y/n prompt appears, approve it, and verify the model reports the output.
- Try declining a prompt (answer `n`) and confirm the model is told the action was declined rather than the CLI crashing.

If Ollama isn't installed, note this step as skipped (consistent with Task 9 of the original plan).

- [ ] **Step 8: Commit**

```bash
git add src/providers/ollama.ts tests/providers/ollama.test.ts src/repl/run-repl.ts
git commit -m "feat: wire tool-calling into Ollama provider and REPL"
```

---

### Task 5: Wire tools into Copilot (Checkpoint 4)

**Files:**
- Modify: `src/providers/copilot.ts`
- Modify: `tests/providers/copilot.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ChatEvent`, `ToolDefinition` from `src/providers/types.ts` (Task 1).
- Produces: `CopilotProvider.chat()` now emits `tool_call` events accumulated from streamed SSE `delta.tool_calls` fragments when `tools` is passed.

- [ ] **Step 1: Write the failing test for Copilot's tool-call accumulation**

Add to `tests/providers/copilot.test.ts`:

```ts
  it('chat with tools accumulates streamed tool_call fragments into one event', async () => {
    await authStore.set('copilot', { githubToken: 'gh-token' });
    const encoder = new TextEncoder();
    const sseLines = [
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '' } }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('copilot_internal')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            token: 'copilot-token',
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
        });
      }
      let i = 0;
      return Promise.resolve({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (i < sseLines.length) return { done: false, value: encoder.encode(sseLines[i++]) };
              return { done: true, value: undefined };
            },
          }),
        },
      });
    }) as unknown as typeof fetch;

    const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
    const events = [];
    for await (const event of provider.chat('gpt-4o', [{ role: 'user', content: 'read a.txt' }], tools)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'tool_call', toolCall: { id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- copilot`
Expected: FAIL — the current `chat` implementation ignores `tool_calls` deltas entirely, so no `tool_call` event is ever yielded.

- [ ] **Step 3: Update `src/providers/copilot.ts` to accumulate and emit tool calls**

Replace the `chat` method with:

```ts
async *chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    const token = await this.getCopilotToken();
    const res = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Copilot chat request failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallsByIndex = new Map<number, ToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          yield* emitToolCalls(toolCallsByIndex);
          return;
        }
        const parsed = JSON.parse(payload) as {
          choices?: {
            delta?: {
              content?: string;
              tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) yield { type: 'text', text: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const existing = toolCallsByIndex.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
        }
      }
    }
    yield* emitToolCalls(toolCallsByIndex);
  }
```

Add this module-level helper function below the class (or above it), and add `ToolCall` to the type import:

```ts
function* emitToolCalls(toolCallsByIndex: Map<number, ToolCall>): Generator<ChatEvent> {
  const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    yield { type: 'tool_call', toolCall: toolCallsByIndex.get(index)! };
  }
}
```

Update the import line at the top of the file to:

```ts
import type { Provider, Message, ChatEvent, ToolCall, ToolDefinition } from './types.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- copilot`
Expected: 6 passed.

- [ ] **Step 5: Build and run the full test suite**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Manual check — live tool-calling with Copilot**

Run `node dist/cli.js chat copilot` (log in first with `node dist/cli.js login copilot` if not already authenticated), and try the same kind of prompts as the Ollama check in Task 4 — creating a file, running a command, and declining a prompt — confirming the y/n flow and results work against the real Copilot API.

- [ ] **Step 7: Update `README.md` to document tool-calling**

Add a new section after "## Usage":

```markdown
## Tool-Calling

Every chat session gives the model access to three tools:

- `read_file` — reads a file's contents (no confirmation needed)
- `write_file` — writes/overwrites a file (asks for y/n confirmation first)
- `run_command` — runs a shell command (asks for y/n confirmation first)

When the model wants to write a file or run a command, you'll see a prompt like:

\`\`\`
Write to hello.txt?
---
hi from the agent
---
 (y/n)
\`\`\`

Answer `y`/`yes` to proceed or anything else to decline. Declined actions are reported back to the model so it can adjust its next step instead of silently failing.
```

- [ ] **Step 8: Commit**

```bash
git add src/providers/copilot.ts tests/providers/copilot.test.ts README.md
git commit -m "feat: wire tool-calling into Copilot provider, document tool-calling in README"
```

---
