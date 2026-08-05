# Tool-Calling Support — Design Spec

Date: 2026-08-05

## Purpose

Extend `ai-term-chat` so the model can call tools to edit files and run shell commands, turning it from a pure chat client into a lightweight coding agent. Destructive/risky actions (writes, command execution) require explicit user confirmation in the terminal before they execute.

## Scope

- Three tools: `read_file`, `write_file`, `run_command`.
- Tool-calling works for both providers: GitHub Copilot and Ollama (for Ollama, only with models that support tool calling, e.g. `llama3.1+`, `qwen2.5`; unsupported models simply chat normally and never emit tool calls).
- Tools are available by default in every chat session — no opt-in flag.
- `read_file` runs without confirmation (non-destructive). `write_file` and `run_command` require a y/n confirmation prompt before executing.

## Provider Interface Changes

`Provider.chat()` changes from yielding raw text chunks to yielding typed events, and gains an optional `tools` parameter:

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
  toolCalls?: ToolCall[];   // set on assistant messages that requested tool calls
  toolCallId?: string;      // set on 'tool' role messages, the id of the call being answered
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

This is a breaking change to the existing `Provider` interface (previously `chat()` yielded `string`). Both providers and the REPL are updated together.

## Tool Implementations

`src/tools/definitions.ts` exports the three `ToolDefinition`s (name, description, JSON-schema parameters) used to advertise tools to the model.

`src/tools/execute.ts` exports:

```ts
export type ConfirmFn = (message: string) => Promise<boolean>;

export async function executeTool(toolCall: ToolCall, confirm: ConfirmFn): Promise<string>;
```

Dispatches by `toolCall.name`:

- **`read_file`** — `{ path: string }`. Reads the file with `fs.readFile`. Returns file contents, or `Error: <message>` if it fails (e.g. not found). No confirmation.
- **`write_file`** — `{ path: string, content: string }`. Calls `confirm()` with a message showing the path and a truncated content preview (first 500 chars). If declined, returns `Write to <path> was declined by the user.` without touching the filesystem. If confirmed, writes the file (creating parent directories as needed) and returns `Wrote <N> bytes to <path>.`
- **`run_command`** — `{ command: string }`. Calls `confirm()` with the exact command. If declined, returns `Command "<command>" was declined by the user.` If confirmed, runs it via `child_process.exec` in the current working directory, capturing stdout+stderr (combined, truncated to 4000 characters) and the exit code, returning a formatted result string including exit code and output.

The `confirm` callback is injected, not hardcoded, so tests can supply a fake (always-yes / always-no) instead of prompting a real terminal.

## Agent Loop

`src/agent-loop.ts` exports:

```ts
export interface AgentDeps {
  confirm: ConfirmFn;
  executeTool: (toolCall: ToolCall, confirm: ConfirmFn) => Promise<string>;
  onText: (text: string) => void; // called as text streams in, for printing
}

export async function runAgentTurn(
  provider: Provider,
  model: string,
  history: Message[],
  tools: ToolDefinition[],
  deps: AgentDeps
): Promise<Message[]>; // returns the new messages appended to history for this turn
```

Behavior: calls `provider.chat(model, history, tools)`; as `text` events arrive, calls `deps.onText` and accumulates them; as `tool_call` events arrive, collects them. When the stream ends:
- If no tool calls were collected, append one assistant message with the accumulated text and return.
- If tool calls were collected, append an assistant message (content = accumulated text, `toolCalls` = the collected calls), then for each tool call: run `deps.executeTool(toolCall, deps.confirm)`, append a `'tool'` role message with `toolCallId` set and `content` = the result, then loop — call `provider.chat()` again with the updated history.
- The loop is capped at **10 rounds**; if still producing tool calls after 10 rounds, stop and append a message noting the round limit was hit, to avoid a runaway loop.

`deps.executeTool` is injectable so `runAgentTurn`'s control flow (round-tripping, history construction, cap enforcement) can be unit-tested with a fake provider and a fake tool executor — no real filesystem or process access needed in those tests.

## REPL Integration

`src/repl/run-repl.ts` is updated to call `runAgentTurn` instead of directly streaming `provider.chat()`. The `onText` callback writes to stdout as before. The real `confirm` implementation prompts via `readline`: prints the message, reads a line, treats `y`/`yes` (case-insensitive) as confirmed, anything else as declined. `executeTool` is `src/tools/execute.ts`'s `executeTool`. The tool list passed to `runAgentTurn` is always `src/tools/definitions.ts`'s full set (no opt-in toggle).

## Provider-Specific Streaming Changes

**Ollama** (`src/providers/ollama.ts`): when `tools` is non-empty, the request is sent with `stream: false` instead of `stream: true` — Ollama returns the full response (`message.content`, `message.tool_calls`) as one JSON object in that mode, which avoids reconstructing partial tool-call JSON from a stream. The provider yields a single `text` event (if `content` is non-empty) followed by one `tool_call` event per entry in `message.tool_calls` (converting each call's `arguments` object to a JSON string, since Ollama returns them as an object rather than a string). When `tools` is empty/omitted, behavior is unchanged from today: streaming `text` events chunk by chunk.

**Copilot** (`src/providers/copilot.ts`): always streams. The request body includes `tools` when provided. Tool-call deltas arrive across multiple SSE chunks as `choices[0].delta.tool_calls`, an array of partial entries keyed by `index`, each with optional `id`, `function.name`, and a fragment of `function.arguments` to concatenate. The provider accumulates these by index in a local map as chunks arrive, still yielding `text` events for any `delta.content` seen along the way, and once the stream ends (`[DONE]` or the reader closes), yields one `tool_call` event per accumulated entry, in index order.

## Testing

Structured as four checkpoints so each can be manually verified in the terminal before moving to the next:

1. **Provider event refactor** — `chat()` yields `ChatEvent`s, REPL updated to consume them, no tool support wired in yet. Existing provider unit tests updated to the new event shape. Manual check: `ai-term-chat chat ollama` / `chat copilot` still stream normal chat responses correctly (regression only).
2. **Tools + confirmation** — `src/tools/execute.ts` and `src/tools/definitions.ts` built and unit-tested (temp directory for file tests, fake `confirm` for yes/no branches, real `child_process.exec` for a trivial command like `echo`). Not yet wired to any provider or the REPL, so no new terminal-visible behavior at this checkpoint.
3. **Ollama gets tools** — `src/agent-loop.ts` built and unit-tested with a fake provider/executor, then wired into the Ollama provider and the REPL. Manual check: run `ai-term-chat chat ollama` with a tool-capable model, ask it to read or write a file or run a command, confirm the y/n prompt appears and the action completes correctly.
4. **Copilot gets tools** — same wiring applied to the Copilot provider's SSE accumulation. Manual check: same kind of live test against `ai-term-chat chat copilot`.

All unit tests continue to mock `global.fetch`; no test hits real GitHub/Ollama/Copilot endpoints. `run_command` tests use a harmless, cross-platform-safe command.

## Out of Scope

- No sandboxing/containerization of `run_command` — it runs with the same privileges as the `ai-term-chat` process itself, in the directory it was launched from.
- No persistent audit log of executed tool calls.
- No tool-call support for the interactive `/model` or `/provider` REPL switch commands beyond what already exists — switching providers/models mid-session simply carries the same `tools` list forward.
