# ACP editor integration (`robin acp`)

Date: 2026-08-20

## Goal

Let editors that speak the Agent Client Protocol (Zed, JetBrains, others) run
Robin as their AI agent — spawn `robin acp` as a subprocess, talk JSON-RPC
2.0 over its stdin/stdout, get a real conversation with streaming replies and
permission prompts inside the editor.

Sources for the protocol details this spec relies on:
[agentclientprotocol.com](https://agentclientprotocol.com/protocol/overview),
[ACPex protocol overview](https://acpex.hexdocs.pm/protocol_overview.html).

## Why this shape

**ACP is another client of the gateway, not a new turn loop.** Robin's whole
architecture already rests on "one gateway daemon owns sessions; the REPL,
channels, and scheduled jobs are each just clients of it" (see the gateway
section of README.md). An ACP-speaking editor asking Robin for a reply is
structurally identical to a Telegram chat asking for one — `robin acp`
becomes a bridge process, the same shape `serve-command.ts` already is for
chat platforms, translating one wire protocol into `GatewayClient` calls
instead of writing a new agent loop. It connects with `kind: 'terminal'` (a
human is on the other end of the editor, approving in real time — the same
trust shape a terminal has, not a channel's allowlist model) and reuses
`GatewayClient` exactly as `run-repl.ts` does.

**Framing is newline-delimited JSON**, confirmed against the ACPex reference
implementation's own description of the transport ("Transport Layer —
Newline-delimited JSON over stdio"). This is the same framing style Robin's
own gateway wire protocol already uses internally, so the low-level
read-a-line/parse/write-a-line mechanics have direct prior art in this
codebase (`gateway/protocol.ts`'s `parseFrame`, `gateway/client.ts`'s
connection handling) even though the message shapes are entirely different
and unrelated to `Frame`/`GatewayEvent`.

**No file system or terminal client capabilities in v1.** ACP lets an editor
offer to handle file reads/writes and command execution itself — useful for a
remote or sandboxed agent. Robin's tools already read and write disk directly
in every other surface (REPL, channels, scheduled jobs), and when the editor
and Robin run on the same machine against the same files, direct I/O is
already correct — there's no sandboxing gap to close. `robin acp` simply
never advertises `clientCapabilities.fs`/`terminal` usage; `initialize`
reports no expectation of them, and every tool call touches disk exactly as
it does today. Revisit only if a genuinely remote/sandboxed use case shows up.

**Every `session/new` starts a brand-new gateway session — no cwd-dedup.**
The REPL reuses a session by matching the working directory
(`resumableSession`/`sessionToOpen` in `run-repl.ts`), because a terminal
reopened in the same place is obviously "the same conversation, continued."
An editor's session boundary is its own concept — it might open several chat
panels against the same workspace — and guessing which of Robin's sessions an
ACP `session/new` "really" means would second-guess a decision the editor
already made explicitly. So the bridge always calls `session.create`, never
searches. `session/load` (ACP's actual resume mechanism) is not implemented,
so `agentCapabilities.loadSession` is reported `false`.

**Tool activity is plain text for v1, not ACP's structured `tool_call`
blocks.** Checked the gateway's event set (`GatewayEvent` in
`gateway/protocol.ts`) before designing this: there is no event carrying a
tool call's id, name, and input at the moment it starts — only
`tool.auto_approved` (a command string), `tool.output` (raw output chunks),
and `approval.request` (`ConfirmRequest`'s kind/message/subject, with no id
that correlates to a specific `ToolCall`). ACP's nicer editor UX — Zed
rendering a diff block for an edit, a collapsible command block — depends on
exactly that structured data. Rather than fabricate an `input` object Robin
doesn't have, or start threading a new tool-call-start event through
`agent-loop.ts`/`session-service.ts` (a real, separate piece of work touching
`PROTOCOL_VERSION` and every existing `GatewayEvent.kind` switch), v1 folds
tool activity into the plain-text `agent_message_chunk` stream: an
auto-approved command shows as `$ <command>` followed by its output, exactly
how the REPL already renders it. **Permission requests are the one thing that
does map cleanly and matters most for safety**, and those get full,
first-class ACP treatment — see below.

**Text-only prompt content for v1.** `PromptRequest.prompt` can carry image
and audio content blocks; Robin's own chat turn (`runTurn`/`Message`) is
text-only end to end today (`Message.content: string`). The bridge extracts
only `type: 'text'` blocks from an incoming prompt and ignores others, rather
than accepting content it has nowhere to route.

## Process and transport

New command: `robin acp`. Like `robin serve`, it calls `ensureGateway()`
first (spawns the daemon if not already running — same one `robin chat` and
`robin serve` use), then connects a `GatewayClient` with `kind: 'terminal'`,
`canApprove: true`.

New module `src/acp/transport.ts`: reads newline-delimited JSON objects from
`process.stdin`, writes newline-delimited JSON to `process.stdout`. Nothing
else may write to stdout — any diagnostic/error output the bridge itself
needs goes to `stderr`, since a stray line on stdout would corrupt the
editor's parse of the next message. This mirrors the constraint MCP stdio
servers already operate under, for the same reason.

```ts
export interface AcpTransport {
  /** Resolves with each parsed message. Malformed lines are dropped, not fatal. */
  onMessage(handler: (msg: Record<string, unknown>) => void): void;
  send(msg: Record<string, unknown>): void;
  close(): void;
}

export function createStdioTransport(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): AcpTransport;
```

## JSON-RPC framing

New module `src/acp/jsonrpc.ts` — the bare envelope, independent of ACP's
specific methods:

```ts
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export function isRequest(msg: Record<string, unknown>): msg is JsonRpcRequest;
export function isNotification(msg: Record<string, unknown>): msg is JsonRpcNotification;
```

A small `JsonRpcConnection` class wraps `AcpTransport` with the request/id
bookkeeping both directions need — the editor sends requests Robin must
answer (`initialize`, `session/new`, `session/prompt`, `session/cancel`), and
Robin sends requests the editor must answer (`session/request_permission`).
Both directions need "send a request, get a promise back keyed by id" and
"receive a request, dispatch to a handler, send the response" — one class
handles both, since ACP is genuinely bidirectional over the same stream, not
a client/server pair with fixed roles.

## The bridge: `src/acp/bridge.ts`

One `AcpBridge` per process (one editor connection, one process — that's how
ACP launches agents). Holds a `Map<string, number>` from ACP `sessionId`
(a string Robin generates, e.g. `randomUUID()`) to the gateway's own numeric
session id.

### `initialize`

No gateway call — pure local negotiation.

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false }
  },
  "agentInfo": { "name": "robin", "version": "<package.json version>" },
  "authMethods": []
}
```

`authMethods: []` — Robin's own `robin login <provider>` already handles
provider authentication outside this surface; ACP's `authenticate` method is
never called because the response declares no methods requiring it.

### `session/new`

```ts
const { params } = request; // { cwd: string, mcpServers?: [...], additionalDirectories?: [...] }
// Same resolution startChat() falls back to when no provider is named on the
// command line — storedChatDefault(), from settings/defaults.ts.
const { provider, model } = await requireStoredDefault();
const snapshot = await client.request<SessionSnapshot>('session.create', {
  providerId: provider.id,
  model,
  cwd: params.cwd,
});
await client.request('session.attach', { id: snapshot.id });
const acpSessionId = randomUUID();
sessions.set(acpSessionId, snapshot.id);
return { sessionId: acpSessionId, modes: undefined }; // no modes offered in v1
```

No stored default (`robin setup` never run) means `session/new` returns a
JSON-RPC error naming the fix — there is no TTY for an interactive picker the
way `startChat()`'s fallback (`pickProviderAndModel()`) has one, so failing
clearly is the only option, not a silent guess at a provider.

`mcpServers`/`additionalDirectories` from the request are accepted and
ignored for v1 — Robin's own MCP config (`~/.robin/mcp.json`) already governs
which servers a session gets, independent of what the editor names; wiring
per-session MCP servers named by the editor is a real feature, just not this
one.

### `session/prompt`

```ts
const gatewaySessionId = sessions.get(params.sessionId); // 404-equivalent JSON-RPC error if missing
const text = params.prompt
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n');

const { turnId } = await client.request<PromptAccepted>('prompt.send', { id: gatewaySessionId, text });
const stopReason = await waitForTurn(turnId, gatewaySessionId); // see below
return { stopReason };
```

`waitForTurn` listens on the same `client.on((sessionId, event) => ...)`
stream `run-repl.ts` already uses, filtered to this `turnId`, translating
each event into an ACP `session/update` **notification** sent to the editor
as it arrives, and resolving once `turn.finished` arrives:

| Gateway event | ACP `session/update` |
|---|---|
| `text` | `agent_message_chunk` with a `text` content block, `messageId: turnId` |
| `thinking` | `agent_thought_chunk` |
| `tool.auto_approved` | `agent_message_chunk`, text `` `$ ${command}\n` `` |
| `tool.output` | `agent_message_chunk`, the raw chunk as text |
| `trim` | `agent_message_chunk`, a short informational line (mirrors what the REPL prints today) |
| `fallback` | `agent_message_chunk`, a short informational line |

`turn.finished`'s `ok`/`aborted`/`error` map to `stopReason` as follows.
`aborted: true` → `"cancelled"`. `ok: true` → `"end_turn"`. A failure
(`ok: false`, not aborted) has no matching value in ACP's `stopReason` enum —
it only has `"end_turn" | "tool_use" | "max_tokens" | "cancelled"`, none of
which mean "errored" — so the failure's message is sent as one last
`agent_message_chunk` first (so it's visible in the transcript, not silently
dropped) and the response still resolves `"end_turn"`, the least misleading
of the four available values for a turn that is, in fact, over.

### `session/cancel` (notification, not a request — no response expected)

```ts
await client.request('turn.interrupt', { turnId: currentTurnFor(params.sessionId) });
```

Reuses the gateway's existing interrupt path — the same one `Esc` in the REPL
already calls.

### Permission requests (Robin → editor, reversed direction)

When `client.on(...)` delivers `approval.request` for a session this bridge
owns, translate and send an ACP **request** (not a notification — this one
needs an answer) to the editor:

```ts
const outcome = await connection.sendRequest('session/request_permission', {
  sessionId: acpSessionIdFor(event.sessionId),
  toolCall: { id: event.approvalId, name: describeKind(event.request.kind), input: null },
  options: [
    { id: 'yes', label: 'Yes, this once', isDefault: true },
    { id: 'no', label: 'No' },
  ],
});
await client.request('approval.answer', {
  approvalId: event.approvalId,
  approved: outcome.outcome === 'approved',
  scope: 'once',
});
```

`event.request.message` (the human-readable description Robin already
builds — "Run \"npm install lodash\"?", a write preview, etc.) is not part of
ACP's `RequestPermissionRequest` shape, so it's folded into an
`agent_message_chunk` sent just before the permission request, the same way
the REPL prints the boxed description before showing its `y/n/a/x` prompt.
Only two options are offered (`yes`/`no`) — ACP's options list doesn't map
naturally onto Robin's `a`/`x` "remember for this kind" scopes, and offering
choices that behave differently from their ACP-standard meaning would be
worse than not offering them; `scope: 'once'` always, so a `session`/`reply`
grant from the REPL never silently applies to an ACP conversation, or vice
versa. Revisit if editors want the wider scopes.

`approval.resolved` events for approvals this bridge itself is waiting on
never fire — a resolution while a client is actively answering the outstanding
`session/request_permission` request only happens if another client answered
first, in which case the editor's eventual response to a request that's
already settled is simply ignored (the corresponding `approval.answer` call
would find nothing pending and return `false`, same as `run-repl.ts`'s own
`openApprovals.delete(...)` check already handles today).

## Wiring

`src/cli.ts` gains:

```ts
program
  .command('acp')
  .description('Speak the Agent Client Protocol on stdio, for editors like Zed and JetBrains')
  .action(async () => {
    await runAcp();
  });
```

`runAcp()` in `src/commands/acp-command.ts` — `ensureGateway()`,
`GatewayClient.connect(...)`, construct `AcpBridge`, wire it to
`createStdioTransport()`, and keep the process alive until stdin closes
(the editor closing the pipe is how an ACP session ends — mirrors how
`serve-command.ts`'s bridges run until their abort signal fires).

## Testing

`tests/acp/jsonrpc.test.ts` — request/notification/response parsing and
serialization, id correlation for both request directions.

`tests/acp/transport.test.ts` — a fake readable/writable stream pair:
newline-delimited messages parse correctly; a malformed line is dropped, not
fatal (mirrors `parseFrame`'s own "malformed is undefined, not an exception"
contract); nothing but transport output ever reaches the writable stream.

`tests/acp/bridge.test.ts` — the bulk of the coverage, against a fake
`GatewayClient` (same fake-provider style already used across
`tests/repl/*.test.ts`):

- `initialize` returns `protocolVersion: 1`, `loadSession: false`, no auth
  methods, no gateway call made.
- `session/new` calls `session.create` with the request's `cwd`, then
  `session.attach`; returns a fresh ACP session id each time, even for the
  same `cwd` twice (proves no dedup).
- `session/prompt` sends only the `text` blocks from a mixed prompt,
  ignoring an `image` block.
- Each gateway event kind produces the documented `session/update` shape,
  in arrival order.
- `turn.finished` with `ok: true` resolves `session/prompt` with
  `stopReason: "end_turn"`; `aborted: true` resolves `"cancelled"`.
- `session/cancel` calls `turn.interrupt` for the session's current turn.
- An `approval.request` event sends `session/request_permission` with an
  `agent_message_chunk` describing it first; the editor's `approved`
  response calls `approval.answer` with `approved: true, scope: 'once'`;
  `rejected` calls it with `approved: false`.
- `session/prompt` for an unknown `sessionId` returns a JSON-RPC error, not
  a thrown exception that would kill the process.

## Out of scope

- `clientCapabilities.fs`/`terminal` — Robin's tools keep touching disk
  directly, as explained above.
- `session/load` (resuming a past ACP session) — every `session/new` is
  fresh.
- `session/set_mode`, config options, `elicitation/create` — no mode
  switching, no structured config exposed, no elicitation forms in v1.
- Image/audio prompt content, `agentCapabilities.promptCapabilities.image`/
  `audio` — Robin's chat turn is text-only; reported `false`.
- Structured `tool_call`/`tool_call_update` blocks — folded into plain text,
  per the discussion above. A real follow-on once the gateway has a
  tool-call-start event with a stable id.
- MCP servers named in `session/new`'s params — Robin's own `mcp.json`
  config governs MCP for every surface uniformly; not overridden per ACP
  session.
- Wider permission-request options (`a`/`x`-equivalent scopes) — only
  yes/no, `scope: 'once'`, for the reasons given above.
