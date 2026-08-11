# Sessions, personality, and multi-agent workflows

Date: 2026-08-11

## Goal

Five features, specified together because three of them depend on the same
refactor:

| | Feature | Size |
|---|---|---|
| **A** | Multiple live sessions, switchable | large |
| **B** | Fan out one prompt to several models and compare replies | medium |
| **C** | Input history persisted across restarts | small |
| **D** | Project-local `PERSONALITY.md`, auto-loaded | small |
| **E** | plan → build → test → validate pipeline with per-role models | largest |

Each ships as its own implementation plan. This document settles the shared
architecture first so the five do not each invent their own version of it.

This spec supersedes the "persisting history across restarts" exclusion in
`2026-08-07-input-history-navigation-design.md`.

## Recommended order

1. Session extraction (Section 1) — pure refactor, no new behaviour
2. C and D — small, independent
3. A, then B
4. E

The refactor is cheap now, with all session state already local to one
function, and expensive once three features have each grown a partial
workaround for its absence.

---

## Section 1 — Shared foundation

`src/repl/run-repl.ts` is 480 lines. The entire session lives in six mutable
locals at lines 100-110: `provider`, `model`, `history`, `inputHistory`,
`systemPrompt`, `toolsEnabled`. That closure is already a session object; it is
just not named. A, B and E each need more than one at a time.

### `src/repl/session.ts` (new)

```ts
export interface Session {
  id: number;               // 1-based; what the user types in /session 2
  label?: string;           // defaults to "provider · model"
  provider: Provider;
  model: string;
  history: Message[];
  systemPrompt?: string;
  toolsEnabled: boolean;
  chatLog: ChatLog;
}
```

Nothing is invented. The existing locals become fields, plus an id and the
per-session `ChatLog` that `startNewSession()` already scopes per conversation.

**Deliberately app-level, not per-session:**

- `inputHistory` — one typing history for the terminal, as a shell has. Losing
  recall by switching sessions would be surprising.
- The four stores (`ConversationStore`, `SkillStore`, `UnsupportedModelStore`,
  `UsageCache`).
- The approval gate. Its "stop asking about commands this session" contract
  (`run-repl.ts:66-91`) means *this process*. Scoping it per session would
  re-prompt for the same decisions after every switch, which trains the user to
  approve without reading — exactly what the gate exists to prevent.

### `src/repl/run-turn.ts` (new)

Lines 382-478 of `run-repl.ts` — push the user message, call `runAgentTurn`,
fall back through candidates on error, roll history back on total failure —
extract to:

```ts
export interface TurnOptions {
  onText: (text: string) => void;
  confirm: ConfirmFn;
  unsupportedStore: UnsupportedModelStore;
  fallback?: boolean;       // default true; /compare sets false
  tools?: boolean;          // default: the session's toolsEnabled
}

export interface TurnResult {
  ok: boolean;
  provider: Provider;       // may differ from the session's, after fallback
  model: string;
  error?: Error;
}

export function runTurn(
  session: Session,
  userMessage: string,
  options: TurnOptions
): Promise<TurnResult>;
```

This is the piece A, B and E all need. A calls it against the active session; B
calls it against N ephemeral sessions concurrently; E calls it once per stage.
Without the extraction, each grows its own copy of the fallback-and-rollback
logic.

`onText` becomes a parameter rather than the direct `process.stdout.write` at
line 414. B cannot interleave four streams into one stdout, so it buffers per
model; E routes stage output through a labelled writer. Injecting the sink is
what makes both possible.

### Command dispatch

About 300 of `run-repl.ts`'s 480 lines are a flat `if (cmd.type === …)` chain.
Adding `/session`, `/compare`, `/workflow`, `/personality` and `/history` would
push it past 700.

Handlers move to `src/repl/commands/`, one module per command group, each with
the signature `(ctx: ReplContext, arg?: string) => Promise<void>`.
`ReplContext` carries the session list, the input history, the stores and the
confirm function. `run-repl.ts` keeps the loop, the prompt and a dispatch
table.

This is refactoring in service of the features. The provider layer, the tool
layer and the UI modules are not touched.

### Testing

The extraction changes no behaviour, so **the entire existing suite must pass
untouched**. A test that needs editing to accommodate it is a signal that
something changed which should not have.

`runTurn` then gets direct unit tests with a stub provider — fallback
ordering, quota-blocked providers skipped, unsupported models recorded, history
rolled back on total failure, and `fallback: false` surfacing the error rather
than substituting a model. These paths exist today but are reachable only
through the whole REPL loop.

---

## Section 2 — Persistent input history (C)

### `src/repl/input-history.ts` (modified)

The existing pure functions are unchanged. `addToInputHistory` keeps its
semantics exactly: blank lines dropped, consecutive duplicates collapsed, capped
at `MAX_INPUT_HISTORY` (200).

A store is added alongside them:

```ts
export class InputHistoryStore {
  constructor(dir?: string);              // defaults to ~/.robin
  async load(): Promise<string[]>;        // oldest first, capped at 200
  async append(line: string): Promise<void>;
}
```

`~/.robin/input-history`, plain text, one entry per line. Newline-delimited
rather than JSON so it stays greppable and hand-editable, consistent with
`~/.robin/chats/` being markdown.

Multi-line prompts are stored with newlines escaped as `\n` and unescaped on
load. Only the two-character escape sequence is decoded, so a prompt containing
a literal backslash followed by `n` round-trips correctly.

`append` is an append, not a rewrite — the common case must not rewrite 200
lines per keystroke-submit. The file is therefore allowed to exceed the cap
between runs, and is compacted to the newest 200 entries once at load. `load`
enforces the cap regardless of what is on disk, so a hand-edited or
externally-grown file cannot bloat memory.

File permissions follow the house pattern established in `auth-store.ts:41-50`:
`mkdir` with `0o700`, `writeFile` with `0o600`, and an explicit `chmod` on every
write because `writeFile`'s mode applies only when it creates the file.

### On the security comment being replaced

`run-repl.ts:103-105` currently justifies session-only history: prompts carry
the same sensitive material as transcripts.

That is true, but transcripts are already written to `~/.robin/chats/` after
every successful turn (`run-repl.ts:467`), and `chat-log.ts:6-10` reasons
explicitly that the private `~/.robin` tree is the right home for exactly this
material. Persisting prompts to the same tree with the same permissions adds no
new class of exposure. It does add volume and longevity, which is a fair thing
to want control over:

- `ROBIN_NO_HISTORY_FILE=1` disables persistence; history stays session-only,
  current behaviour exactly.
- `/history clear` wipes the file and the in-memory ring.
- `/history` prints the file path, so it is discoverable rather than a surprise.

The stale comment is rewritten to state the new reasoning rather than left
contradicting the code.

### Scope and lifecycle

One global file, not per-project. A shell keeps one history across directories
and that is the model people already hold. Per-project would scatter prompt text
into per-directory state, which is harder to audit and harder to clear.

Loaded once at REPL start. Appended per submitted line, fire-and-forget with
errors swallowed — a full disk or a read-only home must never break the prompt.

### Testing

`tests/repl/input-history.test.ts` gains store cases: round-trip including
multi-line prompts and a literal backslash-n, the 200 cap applied on load,
`ROBIN_NO_HISTORY_FILE` honoured, and an unwritable directory tolerated without
throwing.

---

## Section 3 — Project-local `PERSONALITY.md` (D)

### `src/personality.ts` (new)

```ts
export interface Personality { source: string; content: string; }
export async function discoverPersonality(cwd: string): Promise<Personality[]>;
```

Discovery, in precedence order — both are sent, later wins where they conflict:

1. `~/.robin/PERSONALITY.md` — the global default
2. `./PERSONALITY.md` — the working directory

The working directory only, with no walk up to the git root. Directory-walking
means the file shaping the model's behaviour can live somewhere the user is not
looking, which is the wrong property for this.

### Composition

`run-repl.ts:398-403` already establishes the rule: the environment preamble is
always first, because `/system` governs the user's instructions rather than what
Robin knows about its machine. Personality slots between:

```
environmentPrompt()  →  personality  →  systemPrompt
```

Personality sets standing behaviour; `/system` sets the task at hand; the task
should be able to override the tone.

### The trust gate

`PERSONALITY.md` is a file in a repository, and repositories get cloned.
Auto-loading it means `git clone && robin` lets a stranger write the system
prompt — including instructions aimed at the tool layer, which can run commands
and read files. This is a real injection path.

The gate reuses the shape of `createApprovalGate` (`run-repl.ts:66-91`). On
finding a project `PERSONALITY.md` whose SHA-256 has not been approved before,
Robin prints the file and asks once:

```
[y] use it   [n] skip it   [a] always trust this directory
```

Approvals live in `~/.robin/personality-trust.json`, keyed by absolute path,
with two distinct grants:

- **`y`** records the path *and* the current SHA-256. The file loads silently
  while its content is unchanged; editing it re-prompts. Cheap, since the
  person editing it is right there.
- **`a`** records the path with **no hash**, so every future version of that
  file loads silently. This is the grant to use for a repository you own and
  edit constantly, and it is the one to withhold from a repository you cloned.

The distinction matters and is stated in the prompt itself: `y` trusts this
text, `a` trusts this location forever.

The global `~/.robin/PERSONALITY.md` is never prompted for. The user wrote it,
and prompting for one's own config is the noise that trains people to hit *yes*
without reading.

Content is capped at 32 KB. It is **not** wrapped as untrusted the way tool
output is (`wrapUntrusted`, used at `run-repl.ts:322`): once approved it is
genuinely the user's instruction. The gate is the trust boundary, not the
wrapper.

### Commands

`/personality` shows what is loaded and from where. `/personality reload`
re-reads after an edit. `/personality off` drops it for the session.

### Testing

`tests/personality.test.ts` — discovery precedence, composition order relative
to `environmentPrompt()` and `/system`, the size cap, missing files.

The trust gate is the security boundary and gets the most cases, in
`tests/hardening.test.ts` alongside the existing security suite: an unseen hash
prompts, an approved hash loads silently, an *edited* file re-prompts, the
global file never prompts, and a corrupt trust file fails closed.

---

## Section 4 — Multiple live sessions (A)

### `src/repl/session-list.ts` (new)

```ts
export class SessionList {
  create(provider: Provider, model: string): Session;  // 1-based ids, reused after close
  switchTo(id: number): Session;
  close(id: number): void;                             // refuses the last one
  get active(): Session;
  list(): Session[];
}
```

### Commands

| Command | Effect |
|---|---|
| `/session` | list — id, label, provider · model, message count, active marker |
| `/session new` | create via the existing pickers, and switch to it |
| `/session <n>` | switch to session n |
| `/session name <label>` | label the active session |
| `/session close [n]` | close n, defaulting to active; refuses the last remaining |

**Capped at 9.** Single-digit ids keep `/session 3` unambiguous and typo-proof,
and nine parallel conversations is already past what anyone tracks. The cap is a
constant, trivially raised if practice disagrees.

Switching is pure in-memory state: no network, no re-auth. Each session keeps
its own `ChatLog` and therefore its own transcript file.

### Prompt indicator

The prompt shows a session prefix — `2>` instead of `>` — **only once a second
session exists**. A user who never touches `/session` sees no change at all.

This needs a field on `SlashPromptConfig` (`slash-prompt.ts:35-38`), since the
prompt string is hardcoded at line 126.

### Unchanged

`/model`, `/provider`, `/random`, `/system`, `/tools`, `/clear`, `/save`,
`/load`, `/copy` act on the active session, with behaviour identical to today.
`/usage` and `/recall` are account- and disk-wide and are unaffected.

### Testing

`tests/repl/session-list.test.ts` — id allocation and reuse after close, the cap
enforced, closing the last session refused, and switch isolation: mutating one
session's history leaves the others untouched.

---

## Section 5 — Fan-out comparison (B)

Two steps, because choosing four models is a different act from asking a
question:

```
/compare               → multi-select picker; defines the comparison panel
/compare <message>     → sends <message> to every model in the panel
/compare use <n>       → adopts reply n into the active session's history
```

The panel persists for the process, so it is set once and reused. `/compare
<message>` with no panel set opens the picker first.

`<n>` in `/compare use <n>` is the 1-based index printed on each result panel.
Panels render in the panel's configured order, not in completion order, so the
numbering is stable across runs and does not depend on which model answered
first. `/compare use` appends the chosen reply to the active session's history
as an `assistant` message, paired with the user message that produced it, so the
conversation stays well-formed for the next turn.

`src/ui/model-picker.ts` gains `pickManyFromChoices`, matching the existing
searchable-above-20 behaviour of `pickFromChoices` and backed by
`@inquirer/prompts`' `checkbox`. Choices are every model across every
authenticated provider, labelled `provider · model`.

### Execution

Each panel entry becomes an ephemeral `Session` seeded with a **copy** of the
active session's history plus the new message. All run through `runTurn` under
`Promise.allSettled`, concurrency capped at 4. The active session's history is
untouched unless `/compare use` is run.

Three restrictions, each requiring the `TurnOptions` added in Section 1:

- **Tools off.** Four models concurrently hitting the approval gate would
  interleave prompts with no reliable way to tell which model is asking for
  which command. An approval UI that cannot be attributed is worse than none.
  Comparison is for comparing answers.
- **Fallback off.** `runTurn`'s fallback chain silently substitutes a different
  model on failure, which in a comparison would quietly answer a question that
  was not asked. A failed entry renders as an error in its own panel.
- **Output buffered, not streamed.** This is why `onText` is injectable. Four
  concurrent streams into one stdout is unreadable. Replies are collected and
  printed as `renderPanel` boxes on completion, with a spinner naming the models
  still outstanding.

`renderPanel` (`src/ui/panel.ts`) already handles ANSI-aware truncation and
two-column layout, and is reused as-is.

### Cost

A four-model comparison costs roughly four times a normal turn. Before the first
fan-out of a session, `/compare` prints the panel size and, where OpenRouter
models are involved, the usage line already available from `UsageCache`.

### Testing

`tests/repl/compare.test.ts` — panel seeding copies history rather than sharing
it, one entry's failure does not sink the others, the concurrency cap is
respected, and `/compare use` appends the chosen reply to the active session.

---

## Section 6 — The workflow pipeline (E)

### Configuration

`~/.robin/workflows/<name>.json`:

```ts
export type Role = 'planner' | 'builder' | 'tester' | 'validator';

export interface RoleConfig {
  providerId: string;
  model: string;
  instructions?: string;    // overrides the built-in role prompt
}

export interface WorkflowConfig {
  name: string;
  roles: Record<Role, RoleConfig>;
}
```

Four fixed roles. A general stage-DAG engine is a much larger thing to build and
test, and the four-stage shape is the one actually required. The config format
leaves room to add stages later without a migration.

Robin ships built-in instructions for each role, so `/workflow new` asks only
for four provider/model pairs and works immediately. `instructions` exists for
overriding one.

**Commands:** `/workflow new` (wizard, using the existing pickers), `/workflow`
(list), `/workflow use <name>`, `/workflow show` (the role → model table),
`/workflow run <goal>`.

### Stage handoff

Each stage runs as a **fresh conversation**, not a shared growing history,
seeded with a structured brief:

```ts
export interface WorkflowState {
  goal: string;
  plan?: string;
  buildSummary?: string;
  testReport?: string;
  verdict?: { pass: boolean; reasons: string };
  attempt: number;
}
```

| Stage | Receives | Tools |
|---|---|---|
| planner | goal | off |
| builder | goal, plan | on |
| tester | goal, plan, buildSummary | on |
| validator | goal, plan, buildSummary, testReport | on |

Shared history is the obvious alternative and it is the wrong one. The validator
would pay full token cost for three prior stages and — more importantly — would
inherit the builder's reasoning about why its own work is correct, which is
precisely the bias a separate validator exists to remove. Explicit artifacts also
make each handoff inspectable at the checkpoint, and allow retrying one stage
without replaying the others.

The planner runs with tools off: a stage whose job is deciding what to do should
not be editing files while it decides.

### Checkpoints

After each stage Robin prints the output and stops:

```
[a] approve and continue   [r] retry with feedback   [s] skip stage   [q] quit workflow
```

Retry-with-feedback re-runs the same stage with the user's note appended to its
brief. This is more useful than hand-editing the artifact and avoids pulling
`$EDITOR` integration into scope.

### The loop-back

The validator is instructed to close with `VERDICT: PASS` or `VERDICT: FAIL`
plus reasoning. On `FAIL`, Robin offers to loop back to the builder with the
verdict as feedback, **capped at 2 loop-backs** — three build attempts total —
then stops and reports rather than cycling.

If the verdict line is missing or unparseable, Robin says so and asks the user
to decide. It does not guess a pass.

### Safety and cost

**The approval gate is not bypassed.** Three of four stages run with tools on,
meaning real commands and real file writes. `createApprovalGate` applies exactly
as in chat: a workflow automates *prompting*, not *consent*. The gate's existing
"stop asking this session" option is what makes a long run tolerable, and that
is a decision the user makes once, knowingly.

`/workflow run` prints the four models and notes that a full run with one
loop-back is roughly six model turns, before starting.

Unlike `/compare`, fallback stays **on** — if the builder's model is
rate-limited, continuing on another serves the goal. Only one stage runs at a
time, so output streams normally.

### Placement

A run gets **its own session** (Section 4), so pipeline traffic never lands in
the user's chat history and gets its own transcript file. When the run ends the
user is returned to the session they started from, with the workflow session
still open at `/session <n>` for reading back.

New files: `src/workflow/{types,store,prompts,run-workflow}.ts` and
`src/repl/commands/workflow.ts`.

### Testing

`tests/workflow/` — brief construction per stage, asserting that the validator
does **not** receive the builder's reasoning; verdict parsing including the
unparseable case; the loop-back cap at 2; each checkpoint response; and the
planner running with tools off.

---

## Section 7 — Error handling

The governing rule, already implicit in the codebase: **persistence failures
must never break the prompt.** A read-only home directory, a full disk or a
hand-corrupted file degrades a feature; it does not end the session.

| Failure | Behaviour |
|---|---|
| Input-history file unreadable/unwritable | Session-only history; one muted warning at startup, never again |
| `PERSONALITY.md` unreadable or over 32 KB | Muted warning naming the file; Robin continues without it |
| Personality trust file corrupt | Treated as empty, so every project file re-prompts. Fails closed |
| Workflow config corrupt or naming an unknown provider | `/workflow run` refuses, naming the problem; `/workflow show` still lists what parsed |
| A role's provider unauthenticated | Caught before the first stage, not four stages in |
| Session cap reached | `/session new` refuses and names the cap |
| Closing the last session | Refused — `/exit` is how you leave |
| Comparison entry fails | That panel shows the error; the others still render |
| Validator omits `VERDICT:` | Reported as unparseable; the user decides at the checkpoint |

Corrupt-file handling follows the precedent in `conversation-store.ts:31-41`,
where a validator guards against hand-edited JSON reaching live state. The same
shape applies to `WorkflowConfig` and the trust store, for the same reason:
these are plain JSON files that people will edit.

`isValidConversationName` (`conversation-store.ts:19-21`) is the existing
filesystem-safe-name rule. Workflow names and session labels reuse it rather
than introducing a second one.

---

## Testing summary

Vitest, with `tests/` mirroring `src/` as the repo already does. Per-feature
cases are listed in each section above. Two cross-cutting points:

- The Section 1 refactor's proof is the **existing suite passing untouched**.
- `tests/hardening.test.ts` is the existing security suite. The personality
  trust gate and the `0o600`/`0o700` modes on the new files belong there, not
  scattered across feature tests.

**Not covered by automated tests:** terminal rendering of the session prefix and
the comparison panels, and the interactive checkpoint prompts. These get manual
verification, consistent with how UI modules are handled today — `renderPanel`
is unit-tested for layout, but nothing asserts on what the terminal draws.

## Out of scope

- A configurable stage graph for workflows. Four fixed roles.
- Running workflow stages concurrently. Stages are sequential by nature.
- Tool use during `/compare`.
- Sharing sessions or workflows between machines.
- Reverse incremental search (Ctrl-R) over the now-persistent input history.
- Per-project input history.
- Walking up parent directories to find `PERSONALITY.md`.
