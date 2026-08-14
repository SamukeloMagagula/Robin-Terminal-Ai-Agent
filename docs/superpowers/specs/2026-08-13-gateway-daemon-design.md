# Gateway daemon

**Date:** 2026-08-13
**Status:** approved, not yet implemented

## Why

Robin is a process you start, that owns its sessions in memory, and that exits.
`robin chat` and `robin serve telegram` are two processes with two `SessionList`s
that cannot see each other. A conversation started at the keyboard cannot be
continued from Telegram, and a tool call raised by a Telegram turn has no human
to ask — so `serve` offers only a choice between refusing every tool call and
running them unattended.

Every other direction this project might go — a control UI, more channels, an
API other tools can drive — is blocked behind the same missing piece: something
that owns sessions and outlives any one surface.

This milestone moves *ownership*. It changes no model behaviour, no tool
behaviour, and no provider behaviour.

**Success criterion:** a conversation started in the terminal continues from
Telegram and back, live, with tool approvals from either turn answerable at the
keyboard.

## Decisions taken

| Question | Decision |
|---|---|
| What must v1 make possible | One live session, many surfaces |
| How `robin chat` relates to it | Always a client; auto-starts the daemon if none is listening |
| Where approvals go | Broadcast to every attached client that can approve; first answer wins |
| Where tools execute | In the daemon, in the session's recorded working directory |

### Rejected: client-side tool execution

The daemon could ship each tool call to the attached client to confirm *and*
execute. That is truer to "the agent works where you are" and is the only design
that survives a daemon on another machine. It was rejected for v1 because it
roughly doubles the protocol — tool call request/response in both directions —
and a turn started from Telegram with no terminal attached could then run no
tools at all, not even the read-only ones that work today.

The cost of the decision taken: a session's working directory is fixed when the
session is created, so moving your terminal elsewhere and continuing an old
session runs tools in the old directory. Letting a client re-bind the cwd on
attach is a later change, deliberately out of scope.

### Rejected: thin daemon as a session store

A daemon holding only history and metadata, with clients still running turns
themselves, needs no streaming protocol and has no cwd problem. It was rejected
because nothing would own an in-flight turn: two surfaces could run against one
session simultaneously and interleave, which is exactly the corruption
`bridge.ts` already serialises against per-process. It would make sessions
shared but not live, which is not the success criterion.

## Architecture

### The daemon

One process, `robin gateway`, bound to loopback only. It owns the session state
that was REPL-local — the open conversations and their histories — plus the
stores a turn needs: `MemoryStore`, `SkillStore`, `UnsupportedModelStore`,
`ContextLimitStore`.

> **Corrected during implementation.** This section originally claimed those
> stores "were never safe to have two writers on", and Task 12 of the plan was
> going to route every store-backed command through the daemon on that basis.
> It is not true of the file-per-item stores: `MemoryStore` and `SkillStore`
> never cached, so both processes have always read the same files and see each
> other's writes immediately. Task 12 was dropped.
>
> It *was* true of the two stores that cache in memory,
> `UnsupportedModelStore` and `ContextLimitStore` — and only once a daemon
> existed to hold them across the lifetime of a `robin models forget` in
> another process. Both now revalidate against the file rather than being
> owned exclusively.
>
> `ConversationStore` and `RecallSearch` stayed with the REPL: nothing in the
> daemon touches them.

### Transport

WebSocket, one port, default **18790**, overridable with `ROBIN_GATEWAY_PORT`.
JSON frames. 18789 is avoided so a machine running both this and OpenClaw does
not collide.

No HTTP surface in v1. OpenAI-compatible endpoints are a later milestone and
will sit on the same port when they arrive.

This adds one dependency, `ws`, exact-pinned per the policy in `package.json`.

### Auth

On first start the daemon writes `~/.robin/gateway.json` at mode 0600:

```json
{ "port": 18790, "pid": 12345, "token": "<random>", "protocol": 1 }
```

`protocol` is the protocol version this daemon speaks — the same number the
client sends in `connect`. Recording it in the file lets a client notice skew
before it opens a socket.

Every client presents the token in its `connect` frame and is dropped otherwise.
Loopback plus a file only the user can read is the boundary `auth.json` already
relies on — but it matters more here, because anything reaching this socket can
run commands as that user.

### Lifecycle

- `robin gateway start|stop|status` for explicit control.
- `robin chat` reads `gateway.json` and, if nothing is listening — no file,
  dead pid, or connection refused — spawns the daemon detached, waits for the
  port, and connects.
- Daemon output goes to `~/.robin/gateway.log`.
- `robin doctor` gains a gateway check.
- A stale `gateway.json` is a normal condition, not an error.

## Protocol

Client to daemon is request/response with an id. Daemon to client is
unsolicited events scoped to a session. Execution is two-stage: `prompt.send`
returns `accepted` with a `turnId` immediately, then events stream, then a
terminal `turn.finished`.

### Methods

| Method | Purpose |
|---|---|
| `connect` | token, client kind, `canApprove`, cwd, protocol version → `hello-ok` with the session list |
| `session.list` | open sessions and their state |
| `session.create` | provider, model, cwd, optional label, optional `autoApprove` |
| `session.attach` | subscribe to a session; returns a history snapshot |
| `session.close` | close a session |
| `session.update` | model, provider, system prompt, tools on/off, label |
| `session.clear` | reset history |
| `prompt.send` | send a user message; returns `accepted` with `turnId` and queue position |
| `turn.interrupt` | abort the in-flight turn |
| `approval.answer` | resolve a pending approval |

### Events

`turn.started`, `text`, `thinking`, `tool.auto_approved`, `tool.output`,
`approval.request`, `approval.resolved`, `fallback`, `trim`, `turn.finished`,
`session.changed`.

That list is deliberately the callback surface `runTurn` already exposes —
`onText`, `onThinking`, `onAutoApproved`, `onOutput`, `onFallback`, `onTrim`,
`confirm` — turned into frames. The daemon wires those callbacks to a
broadcast; nothing in the turn logic learns that a socket exists.

### Attach returns the conversation

`session.attach` returns a history snapshot, so a terminal connecting
mid-conversation renders what came before rather than starting blank. Events
after that point are live.

### One turn at a time per session, queued FIFO

The per-chat promise chain in `bridge.ts` moves into the daemon and becomes the
rule for every surface: two messages arriving during a turn no longer race on
one history array. `prompt.send` on a busy session is accepted with its queue
position rather than rejected — the terminal can say "queued behind 1", and
Telegram behaves as it does today.

### Worked example

1. Telegram message arrives at the bridge, now a client.
2. Bridge sends `prompt.send`.
3. Daemon runs `runTurn`.
4. `text` events broadcast to every client attached to that session, so the
   terminal shows the reply arriving.
5. The model calls `run_command`.
6. `approval.request` broadcasts to clients with `canApprove`.
7. The user answers at the keyboard; `approval.answer` resolves the `ConfirmFn`
   promise inside the daemon.
8. The command runs in the session's recorded cwd; `tool.output` streams.
9. `turn.finished`.
10. The bridge posts the accumulated final text to Telegram, as it does now.

## Components

### New, under `src/gateway/`

| File | Responsibility | Depends on |
|---|---|---|
| `protocol.ts` | Frame types, protocol version constant | nothing |
| `server.ts` | WebSocket server, auth, connection registry, frame dispatch | `protocol`, `session-service`, `approvals` |
| `session-service.ts` | Owns `SessionList` and the stores; runs turns; per-session queue | `run-turn`, stores |
| `approvals.ts` | Pending registry, broadcast, first-answer-wins, timeout; provides the `ConfirmFn` | `protocol` |
| `client.ts` | Connect, id-matched request/response, typed event stream | `protocol` |
| `discovery.ts` | Read/write `gateway.json`, liveness, spawn-and-wait | nothing |

Plus `src/commands/gateway-command.ts` for `start|stop|status`.

`session-service.ts` holds the daemon's real logic and has no idea what a socket
is. That separation is what makes it testable without a network.

### Unchanged

`agent-loop.ts`, `run-turn.ts`, `memory/`, `skills/`, `mcp/`, `recall/`,
`workflow/`. The daemon calls `runTurn` the same way the REPL does today.

> **Corrected during implementation.** `tools/` and `providers/` were on this
> list and should not have been.
>
> `tools/execute.ts` had to learn a `cwd`: the daemon has one working
> directory and its sessions have their own, and without threading it through,
> "run the tests" runs them wherever the daemon happens to live.
> `isInsideCwd` became `isInsideDir` — the same containment check, asked about
> the right directory.
>
> `providers/unsupported-models.ts` and `providers/context-limits.ts` cache in
> memory, and the daemon holds them for its whole life while
> `robin models forget` runs in another process. Both now revalidate against
> the file.

### Changed

**`src/repl/commands/` is where the work is.** Ten handler modules currently
reach into `ctx.session` and mutate it; each becomes an RPC call. This is more
edited lines than the gateway itself and is the riskiest part of the milestone.

- RPC: `/model`, `/provider`, `/random`, `/system`, `/tools`, `/clear`,
  `/session`, `/save`, `/load`, `/personality`, `/memory`, `/skill`,
  `/workflow`, `/recall`.
- Stays client-side: `/help`, `/copy`, `/history`, `/usage`. Clipboard, input
  history and the spend figure never belonged to a session.

`ctx.session` will **not** become a proxy object that looks local but does RPC
underneath. Field assignment cannot await, so a proxy would swallow failures and
hide latency at exactly the moments that matter. Handlers get explicit
`await ctx.client.…` calls instead.

`run-repl.ts` ends up smaller: no stores, no `SessionList`, no gate wiring. It
connects, renders events, dispatches commands.

`bridge.ts` loses its sessions, stores and queues and becomes a second, thinner
client.

## Approvals

**Capability, not client type.** A client declares `canApprove` at `connect`.
Terminals do; the Telegram bridge does not. `approvals.ts` broadcasts a pending
request to every client that can approve; the first answer wins, and the others
receive `approval.resolved` and clear their box.

**The prompt names its origin.** If a Telegram-driven turn wants to run
`npm publish`, the box at the keyboard says the request came from Telegram, from
that sender, in that session. Without it the user cannot tell a command they
triggered from one a remote message triggered, and the gate stops meaning
anything. This is the most important detail in this section.

**No approver attached means denied**, immediately, with the reason. That is
today's `serve` behaviour, preserved.

**`--allow-tools` becomes session policy.** Instead of a flag on a process it is
an `autoApprove` property the bridge sets at session creation — visible in
`/session` and in `robin gateway status`. The same capability, now inspectable,
which matters for something this dangerous.

**Timeout is five minutes, and resolves to a denial.** The message back to the
model distinguishes a timeout from a refusal, though both carry the don't-retry
guidance added in `DECLINE_GUIDANCE`.

**The decline memory moves daemon-side.** The per-reply refusal state in
`src/repl/approval-gate.ts` belongs beside the pending registry, keyed by
session. Semantics unchanged; it stops being a REPL-local closure.

**To verify early in implementation:** the REPL uses `@inquirer/prompts`'
`expand`, and a losing terminal needs its open prompt cancelled when another
client answers first. If that version's prompt is not cancellable, the fallback
is to accept the stray answer and discard it with a printed note.

## Failure modes

| Failure | Behaviour |
|---|---|
| Protocol version skew | `connect` carries a version; mismatch is refused with a message naming the fix, and `robin chat` offers to run `robin gateway stop` |
| Two `robin chat` racing to auto-start | The loser gets `EADDRINUSE`, waits briefly, connects to the winner |
| Stale `gateway.json` | Pid dead → overwrite and start fresh. Foreign process on the port → fail loudly, naming the override |
| Daemon dies mid-turn | Client says so plainly, reconnects with backoff, re-attaches, renders the snapshot. What streamed is already in the transcript |
| Client dies mid-turn | The turn continues. A Telegram turn must not die because a terminal closed. The result is in the snapshot on re-attach |
| Only approver disconnects with an approval pending | Resolves to a denial rather than hanging |

Version skew is the one that will actually bite: auto-start means an old daemon
lingers after a rebuild.

## Non-goals

- ~~**Sessions do not survive a daemon restart.**~~ **Done in a follow-up.**
  Sessions are written to `~/.robin/sessions/` after every turn rather than on
  shutdown — on Windows `robin gateway stop` terminates the daemon outright and
  no exit handler runs, so a save-on-exit design would have lost every
  conversation on the platform it most needed to work on. Writing as it goes
  also survives a crash and a reboot.
- No HTTP or OpenAI-compatible endpoints.
- No control UI.
- No new channels.
- No re-binding a session's working directory.
- No remote (non-loopback) access.

## Testing

- `session-service.ts` and `approvals.ts` are tested directly, with no socket.
  They hold the logic, and the existing `runTurn` fakes carry over.
- `approvals.ts`: first-answer-wins, no-approver-denies, timeout, resolved
  broadcast, origin in the message.
- `discovery.ts`: stale file, dead pid, foreign process on the port.
- Protocol round-trips run over a real WebSocket on an ephemeral port. A fake
  duplex stream would not catch framing or auth mistakes.
- One end-to-end test: two clients on one session; one sends a prompt, both see
  the text, and the client that can approve resolves a tool call for the one
  that cannot.
- The existing suite stays green. REPL command tests move to asserting RPC calls
  against a fake client.
