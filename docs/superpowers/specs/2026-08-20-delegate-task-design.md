# Subagent delegation (`delegate_task`)

Date: 2026-08-20

## Goal

Let the model spawn parallel, isolated subagents mid-turn — Hermes Agent's
`delegate_task`. A tool call takes a batch of subtasks, runs each as a fresh,
historyless agent with a restricted toolset, concurrently, and returns their
results back into the parent conversation.

## Why this shape

**The gateway side needs no changes.** `ApprovalRegistry` (`src/gateway/approvals.ts`)
already holds an arbitrary number of concurrent pending approvals per session
(`entries: Map<string, Entry>`), broadcasts each independently, and lets
whichever client answers first settle it. Concurrency was never the gateway's
problem.

**The actual gap is the REPL's rendering.** `askApproval` in `run-repl.ts`
calls `expand(...)` (an `@inquirer/prompts` call) the instant an
`approval.request` event arrives, with no queueing. Two events arriving close
together — which is exactly what concurrent subagents produce the moment two
of them hit a confirm-gated tool at once — would mean two live `inquirer`
prompts fighting over the same stdin/stdout. That is the piece this spec
actually has to solve.

**Subagents reuse the confirm function already in scope, not a new kind.**
`executeTool`'s switch already receives a `confirm: ConfirmFn` bound to the
calling session (`session-service.ts`'s `runOne` passes
`this.deps.approvals.confirmFor(id, origin, record.autoApprove, governance)`).
A subagent spawned from inside one `executeTool` call for `delegate_task` is
still *this session's* work — the same human is still the one being asked —
so its nested tool calls are gated by that exact same `confirm`, not a
manifest-widened or auto-approved path. `delegate_task` itself is not
confirm-gated to start: everything it does is already gated individually one
level down, and gating the batch as well would just be asking twice.

**Subagents get a restricted toolset by construction, not by policy.** They
are handed `TOOL_DEFINITIONS` (`read_file`, `write_file`, `edit_file`,
`run_command`) as their tool list — nothing else exists for the model to call.
No `memory`, `skills`, `media`, `mcp`, and critically not `delegate_task`
itself: the tool list a subagent's `runAgentTurn` call is given simply does
not include it, so recursive spawning is not something the model can request,
not something refused at runtime.

**Isolation reuses `runAgentTurn` directly, not `runTurn`/`Session`.**
`workflow/run-workflow.ts`'s `runStage` is the closest prior art — a fresh
`createSession` plus `runTurn` per stage, no shared history. But `run-turn.ts`
already imports `execute.ts` (to wire `executeTool` into `runAgentTurn`'s
deps), so `execute.ts` importing `run-turn.ts` back would be a circular
import. `agent-loop.ts` has no such cycle — it only takes a *type-only* import
from `execute.ts` (`ConfirmFn`), which is erased at compile time — so
`delegate_task`'s handler calls `runAgentTurn` directly with a synthetic
one-message history per subtask. This means subagents don't get the parent
session's fallback chain or context trimming; acceptable for v1, since a
subtask's history is intentionally small (one prompt, no prior turns) and
unlikely to hit either.

## The `delegate_task` tool

Added to `SKILL_TOOL_DEFINITIONS`'s neighbourhood conceptually but lives in
its own export — a new `DELEGATE_TOOL_DEFINITIONS` in `src/tools/execute.ts`,
offered whenever a `provider`/`model` are available in `ExecuteOptions` (see
below), the same conditional-offering pattern `media`/`memory`/`skills`
already use.

```ts
{
  name: 'delegate_task',
  description:
    'Run up to 4 subtasks in parallel, each as a fresh agent with no memory of ' +
    'this conversation and no shared context between subtasks. Use for work that ' +
    'genuinely splits into independent pieces — reviewing several files, researching ' +
    'several unrelated questions — not for a single sequential task, which runs faster ' +
    'without the isolation overhead. Each subtask needs a self-contained prompt: it ' +
    'cannot ask you anything back, and cannot see what you already know.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short name for this subtask, shown in the result.' },
            prompt: { type: 'string', description: 'Everything the subtask needs — full context, since it starts blank.' },
          },
          required: ['label', 'prompt'],
        },
      },
    },
    required: ['tasks'],
  },
}
```

### Handler

```ts
export interface ExecuteOptions {
  // ...existing fields...
  /** Enables delegate_task when present, alongside a model to run subtasks with. */
  delegate?: { provider: Provider; model: string };
}
```

```ts
async function delegateTaskTool(
  args: Record<string, unknown>,
  confirm: ConfirmFn,
  delegate: { provider: Provider; model: string },
  baseOptions: ExecuteOptions // cwd, mcp — NOT memory/skills/media/delegate itself
): Promise<string> {
  const tasks = requireTaskList(args.tasks); // validates shape, length 1-4
  const results = await Promise.all(
    tasks.map(async (task) => {
      try {
        const messages = await runAgentTurn(
          delegate.provider,
          delegate.model,
          [{ role: 'user', content: task.prompt }],
          TOOL_DEFINITIONS,
          {
            confirm,
            executeTool: (toolCall, cf) =>
              executeTool(toolCall, cf, { cwd: baseOptions.cwd, mcp: baseOptions.mcp }),
            onText: () => {}, // subagent output is not streamed to the terminal live
          }
        );
        const reply = messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? '';
        return { label: task.label, ok: true, output: reply };
      } catch (err) {
        return { label: task.label, ok: false, output: (err as Error).message };
      }
    })
  );
  return results
    .map((r) => `## ${r.label}${r.ok ? '' : ' (failed)'}\n${r.output}`)
    .join('\n\n');
}
```

One subtask throwing does not fail the others — caught per-task, reported
inline as `(failed)` with the error message, same spirit as
`runMcpTool`/`runCommandTool` reporting failure as text rather than throwing
out of `executeTool`.

Not wrapped as `wrapUntrusted`: like a workflow stage's output, this is
Robin's own synthesis of work it was asked to do, not raw external data. Any
file contents or command output a subagent touches is *already* wrapped
individually by the nested `executeTool` calls that produced it.

### Wiring

`TurnOptions` (`run-turn.ts`) hand-picks the fields it forwards to
`executeTool` individually — `memory`, `skills`, `media`, `mcp` are each named
explicitly, not passed through generically — so `delegate` needs the same
treatment in two places, not one:

1. `TurnOptions` gains `delegate?: { provider: Provider; model: string }`,
   and the `executeTool(...)` call inside `runTurn` gains `delegate: options.delegate`
   alongside its existing `memory: options.memory, skills: options.skills, media: options.media`.
2. `session-service.ts`'s `runOne` passes `delegate: { provider: session.provider, model: session.model }`
   into the `runTurn(...)` call — same provider/model the parent turn is
   using, no new selection surface for v1.

## The approval queue

New `src/repl/approval-queue.ts`:

```ts
export class ApprovalQueue {
  /** Runs `render` once nothing else queued ahead of it is still showing. */
  enqueue(id: string, render: () => Promise<void>): void;
  /**
   * An approval settled by another client before this queue reached it.
   * Marks it so enqueue() skips rendering a now-stale prompt instead of
   * showing it only to immediately cancel it.
   */
  settleElsewhere(id: string): void;
}
```

Internally: a promise chain (`this.tail = this.tail.then(...)`), each link
checking a `Set<string>` of ids settled elsewhere before calling `render`.
Errors from one `render` must not break the chain for the next — caught and
swallowed at the link level, same as `AutonomyStore`/`AuditLog`'s queued
writes already do for their own chains.

### Wiring in `run-repl.ts`

`askApproval`'s dispatch changes from calling it directly to:

```ts
const queue = new ApprovalQueue();
// ...
if (event.kind === 'approval.request') {
  queue.enqueue(event.approvalId, async () => {
    const { answer, cancel } = askApproval(event);
    openApprovals.set(event.approvalId, cancel);
    const { approved, scope } = await answer;
    if (!openApprovals.delete(event.approvalId)) return;
    await client.request('approval.answer', { approvalId: event.approvalId, approved, scope }).catch(() => {});
  });
  return;
}
if (event.kind === 'approval.resolved') {
  const cancel = openApprovals.get(event.approvalId);
  if (cancel) {
    // Already rendering — cancel it in place, as today.
    openApprovals.delete(event.approvalId);
    cancel();
    console.log(mutedColor(`Answered elsewhere (${event.approved ? 'yes' : 'no'}).`));
  } else {
    // Still queued, not yet rendering — skip it when its turn comes.
    queue.settleElsewhere(event.approvalId);
  }
  return;
}
```

## Testing

`tests/tools/execute.test.ts` (or a new `tests/tools/delegate-task.test.ts`):

- Runs `tasks.length` subtasks and returns one section per label.
- Subtasks run concurrently — proven by a fake `Provider.chat` that records
  start order vs. completion order (e.g. task A sleeps longer than task B but
  B is still requested before A's `chat()` call resolves), not just "both
  ran."
- A subtask's tool calls are gated by the same `confirm` passed to the outer
  `delegate_task` call.
- A subagent cannot see `memory`/`skills`/`media`/`delegate_task` tools — its
  `runAgentTurn` tool list is exactly `TOOL_DEFINITIONS`.
- One subtask throwing does not stop the others from completing, and is
  reported as `(failed)` with its message rather than propagating.
- More than 4 tasks is refused with a clear error before anything runs.
- `delegate_task` is absent from the tools offered when `ExecuteOptions.delegate`
  is not provided (mirrors how `media`/`memory`/`skills` tools are already
  conditionally offered).

`tests/repl/approval-queue.test.ts`:

- Two `enqueue` calls render strictly one after another — the second's
  `render` is not invoked until the first's promise resolves.
- `settleElsewhere` on an id not yet rendered skips its `render` entirely when
  its turn arrives.
- `settleElsewhere` on an id with no matching queued entry is a no-op (the
  existing `openApprovals`-based cancel path already handles the
  already-rendering case; the queue only owns the not-yet-rendered case).
- An error thrown by one `render` does not prevent the next queued entry from
  running.

## Out of scope

- Streaming a subagent's text live to the terminal. `onText: () => {}` for
  v1 — the parent sees only the final combined result. Live-streaming four
  concurrent text streams into one terminal is a real UI problem of its own,
  not solved here.
- Choosing a different provider/model per subtask, or per `delegate_task`
  call. All subtasks use the parent session's own provider/model.
- Subagents calling `delegate_task` themselves (nested delegation). Not
  offered the tool at all, by construction.
- Fallback chain and context trimming for subagent turns — `runAgentTurn`
  direct, not `runTurn`. Acceptable given a subtask's history starts at one
  message.
- A cap higher than 4, or a configurable cap. Fixed for v1; revisit if it
  proves limiting.
