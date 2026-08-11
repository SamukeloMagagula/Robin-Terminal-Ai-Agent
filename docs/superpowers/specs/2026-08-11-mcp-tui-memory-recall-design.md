# MCP, terminal depth, memory, and indexed recall

Date: 2026-08-11

## Goal

Four capabilities borrowed from [Hermes Agent](https://github.com/NousResearch/hermes-agent),
adapted to Robin rather than copied:

| | Feature | Size |
|---|---|---|
| **F** | MCP server support | large |
| **G** | Terminal depth — multiline input, interrupt, streaming tool output | medium |
| **H** | Agent-curated memory and a user profile | medium |
| **I** | Indexed recall, and skills as portable markdown | medium |

Hermes is Python; Robin is TypeScript. Nothing transfers as code — these are
borrowed designs, the same way `2026-08-07-hermes-style-banner-design.md`
borrowed a layout and rejected the palette.

Each ships as its own implementation plan. This document settles the shared
decisions — dependency policy, prompt composition, the write paths — so the
four do not each answer them differently.

## Recommended order

1. **G** — the abort plumbing is a foundation change, and `runTurn` has exactly
   one caller today. After sessions, `/compare` and the workflow pipeline exist,
   adding cancellation means touching all of them.
2. **F** — highest leverage of the four.
3. **H**
4. **I**

## Global constraints

**Dependencies.** `package.json` pins exact versions deliberately; the
`//dependencies` comment explains why. Two new runtime dependencies are
approved for this batch, both exact-pinned:

- `@modelcontextprotocol/sdk` — the official MCP client. Hand-rolling JSON-RPC
  was considered; protocol drift is a real maintenance cost and the SDK is the
  reference implementation.
- `better-sqlite3` — FTS5 for recall.

**`better-sqlite3` is a native module, and this repo runs npm with an
allow-scripts policy** — `npm ci` already warns that `esbuild`'s postinstall is
unapproved.

> **Corrected after implementation.** This section originally predicted that
> installing `better-sqlite3` would require an explicit `npm approve-scripts`
> entry, and that "clone and `npm ci`" would gain a step. It did not: version
> 13.0.3 installed from a prebuilt binary on Windows/Node 20 without tripping
> the script gate, and FTS5 was available immediately. The prediction may still
> hold on a platform with no matching prebuild, which is precisely why the grep
> fallback below is required rather than optional — but the README must not
> tell users to run `approve-scripts` when they generally will not need to.

**Everything degrades.** A missing index, an absent memory directory, a dead
MCP server, or a native module that will not load disables *that feature* with
one muted line. None of them may end the session.

---

## Section 1 — MCP support (F)

### Configuration

`~/.robin/mcp.json`, using the shape other MCP hosts use so server blocks can
be pasted from their documentation:

```jsonc
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/code"]
    },
    "github": { "command": "gh-mcp", "args": [], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

**stdio transport only in this batch.** Streamable HTTP is a second transport
with its own authentication story; stdio covers essentially every server that
exists today, and adding the second later needs no config migration.

A corrupt or wrongly-shaped `mcp.json` fails closed to zero servers, following
the precedent in `conversation-store.ts:31-41`.

### Components

`src/mcp/config.ts` — load and validate.
`src/mcp/client.ts` — one connection per server. **Lazy:** no process spawns
until a turn actually needs tools, so a user who never enables tools pays
nothing.
`src/mcp/registry.ts` — merges discovered tools into `TOOL_DEFINITIONS`.

### Naming

MCP tools are exposed to the model as `server__tool` —
`filesystem__read_file`, distinct from Robin's built-in `read_file`.

Without the prefix, a server could declare a tool named `read_file` and
silently shadow the built-in, intercepting every call. The prefix is a
security boundary, not cosmetics.

### Security

Three properties, and these are the parts to review hardest.

**Every MCP tool call goes through the approval gate**, via a new
`ConfirmRequest` kind `mcp_tool`. Robin's own `run_command` auto-approves when
`command-safety.ts` recognises the command as read-only. **No MCP tool ever
auto-approves** — there is no equivalent analysis available for an opaque
third-party tool, and inferring safety from a name the server chose would be
trusting the thing being gated. The gate's existing "stop asking about this
kind this session" option is the pressure valve.

**Results are wrapped with `wrapUntrusted`**, for the reason tool output
already is: a server's response is attacker-controlled text entering the
model's context.

**A server entry is a command Robin will execute.** `mcp.json` saying
`npx -y some-package` means Robin runs it. That earns the treatment
`PERSONALITY.md` received: on first sight of a new or changed server entry,
print the command and ask, keyed by content hash. This reuses
`PersonalityTrustStore`'s shape — generalised to a shared
`src/trust-store.ts` rather than duplicated — including the two grant kinds
(`y` trusts this exact entry, `a` trusts this server name whatever it becomes).

### Failure handling

| Failure | Behaviour |
|---|---|
| Server will not start | That server disabled, one muted line, turn continues on remaining tools |
| Server dies mid-session | Same; not retried until restart |
| Server slow to start | 10s timeout, then disabled |
| `tools/list` returns nothing | Server connected but contributes no tools; not an error |
| One bad entry in `mcp.json` | Other servers unaffected |

### Testing

`tests/mcp/` — config validation including the corrupt case, `server__tool`
namespacing, a stub server that never starts leaving other tools usable, and
the trust gate refusing an unapproved server entry. The last belongs in
`tests/hardening.test.ts` alongside the personality gate.

---

## Section 2 — Terminal depth (G)

Three separable pieces.

### Multiline input

`promptWithSlashMenu` currently mirrors `rl.line` into a single-line render
(`slash-prompt.ts:126`). Multiline means owning a buffer and cursor, rendering
N lines, and reserving a key for newline-versus-submit.

**Enter submits; Alt+Enter inserts a newline.** Shift+Enter does the same where
the terminal sends a distinguishable sequence — many do not, which is why
Alt+Enter is the documented one. A trailing `\` also continues onto the next
line, as a keyboard-independent fallback.

Enter-submits keeps existing muscle memory intact; inverting it would break
every user's habit to serve the rarer case.

Up/down keep their current three-way behaviour (`slash-prompt.ts:63-87`) with
one addition: inside a multiline buffer they move between *lines* first, and
only reach into input history from the first or last line. Otherwise editing
line two of a paragraph would silently discard it.

### Interrupt-and-redirect

Esc during a streaming reply stops it. An `AbortSignal` threads
`runTurn` → `runAgentTurn` → `provider.chat`, and each provider passes it to
its `fetch`.

**Esc is already bound** — `slash-prompt.ts:102` uses it to close the
slash-command popup. The two coexist because they belong to different modes,
and the rule is worth stating the way the up/down conflict was in
`2026-08-07-input-history-navigation-design.md`:

- **Prompt is accepting input** — Esc closes the popup if open, otherwise does
  nothing. Unchanged behaviour.
- **A reply is streaming** — the prompt is not accepting input at all, and Esc
  aborts the turn.

No keybinding is lost and no modifier is introduced.

The partial reply stays in history, marked as interrupted, so the next message
reads as a redirect rather than a non-sequitur.

**Ctrl-C keeps meaning quit.** Overloading it to cancel a turn is how people
lose a session they meant to keep.

**This is why G comes first.** `runTurn` has one caller today. After Section A
(sessions), `/compare` and the workflow pipeline exist, threading cancellation
means touching all of them *and* deciding what abort means with four models
streaming at once. Today it is a handful of signatures.

### Streaming tool output

`execute.ts` buffers a command's output and returns it whole, so a test suite
or an install shows a dead terminal until it finishes.

It gains an `onOutput` callback streaming stdout and stderr live, dimmed and
indented like the existing `onAutoApproved` line. **What the model receives is
unchanged**, including current truncation — this is purely what the human sees.

### Testing

Buffer mechanics (insert, newline, cursor movement, up/down line-versus-history)
are unit-testable through the existing fake-TTY harness in
`tests/repl/slash-prompt.test.ts`. Abort is testable with a stub provider whose
generator never completes. Rendering of a multiline buffer and dimmed streaming
output is verified manually, consistent with how UI is handled today.

---

## Section 3 — Memory and user profile (H)

### Storage

`~/.robin/memory/` — one markdown file per memory, plus `MEMORY.md` as a
one-line-per-entry index. Frontmatter carries `name`, `description`, and `type`
(`user` | `project` | `reference`). `profile.md` is the accumulating model of
the user.

Plain files: hand-editable, greppable, deletable with `rm`. Same principle that
makes transcripts markdown.

### The index/body split

**Only `MEMORY.md` and `profile.md` enter the system prompt.** Full bodies are
fetched by a `recall_memory` tool when an index line looks relevant.

Loading every memory would grow the prompt without limit, until a long-running
user pays for their entire history on every turn. The index line exists to be
cheap enough to always send.

Caps: `profile.md` 4 KB, `MEMORY.md` 8 KB.

Over the cap, index lines are dropped **from the prompt only, never from
disk**, in `MEMORY.md` file order — which is creation order, since `remember`
appends. Oldest-created goes first.

Explicitly *not* modification time: updating a memory would push it to the
front and evict something more important, so the ranking would drift every time
a file was touched. File order is stable, and because the file is
hand-editable, a user who disagrees can simply move a line up. `/memory` marks
which entries are currently being sent.

### Writing

Through a `remember` tool the model calls — so it goes through the tool layer,
appears in the transcript, and is a visible action rather than a side effect.

The tool description forbids storing credentials, tokens, or key material. A
memory that duplicates an existing one updates that file rather than adding a
second.

### Nudges

On every 10th turn **of the current session**, counted in memory and reset by a
restart or `/clear`, a line joins the system prompt: *consider whether anything
in this conversation is worth persisting.*

Session-scoped rather than cumulative, and deliberately so: the nudge exists to
catch things learned in *this* conversation, and a persisted counter would fire
on turn one of a fresh session about an unrelated topic. A short session that
never reaches ten turns simply never nudges — the `remember` tool is still
available the whole time, and the model may call it unprompted.

This is Hermes' closed loop, and it is what makes agent-curated memory actually
accumulate: without it, the model has a tool it rarely thinks to use.

### Commands

`/memory` lists, `/memory show <name>` prints one, `/memory forget <name>`
deletes.

### The tradeoff, stated

**Robin will write things about the user to disk without asking first.** That
is what "agent-curated" means and it was chosen deliberately. The mitigations —
plain text, listed, deletable — are all *after* the fact.

If it proves uncomfortable in use, switching to propose-and-approve is a change
to one function: `remember` routes through `ctx.confirm` instead of writing
directly. The implementation should keep that seam obvious.

### Testing

Index/body split (bodies never in the composed prompt), caps enforced,
duplicate memory updates rather than appends, nudge appears on the 10th turn and
not the 9th, `forget` removes the file and the index line, corrupt frontmatter
skips one entry rather than failing the load.

---

## Section 4 — Indexed recall and markdown skills (I)

### Recall

SQLite FTS5 at `~/.robin/index.db`, indexing `~/.robin/chats/*.md`
incrementally as `chatLog.write` runs — fire-and-forget, errors swallowed, the
prompt never waits on it.

`/recall` becomes a ranked BM25 query returning snippets, replacing the linear
grep in `recall.ts`.

First run backfills existing transcripts with a progress line, since a silent
multi-second pause on startup reads as a hang.

**Summarisation is opt-in: `/recall -s <query>`.** Hermes summarises hits with
an LLM. Doing that on every search means a silent extra API call, and cost, for
what is usually just "show me the hits."

**Fallback is required, not optional.** `better-sqlite3` is native and, with
the allow-scripts policy above, its install can legitimately fail. If the module
will not load, `/recall` uses the existing grep implementation and says so once.
Robin must not become unusable because a prebuild was missing.

### Skills as markdown

`~/.robin/skills/<name>/SKILL.md` with `name` and `description` frontmatter —
the agentskills.io shape, so skills are portable to and from other tools.

Existing `~/.robin/skills/*.json` presets still load as a legacy format.
`/skill migrate` converts them and reports what moved.

Same index/body split as memory: descriptions in the prompt, body loaded via a
`use_skill` tool on demand.

Robin creates skills itself after complex work, via a `create_skill` tool that
goes through the approval gate like any other write.

### Testing

FTS ranking returns the better match first; incremental indexing adds only new
content; a missing or unloadable module falls back to grep; frontmatter parsing
including a malformed file; JSON→markdown migration preserves the prompt text;
skill bodies stay out of the composed prompt.

---

## Cross-cutting

### Prompt composition

```
environment → personality → profile + memory index → skill index → /system
```

Extending the order already fixed in `session.ts`. Memory and skills are
context, so they sit after personality and before the user's own instructions —
`/system` stays the last word.

`/context` prints the breakdown with byte sizes, so a prompt that has grown
expensive is visible rather than inferred from a bill.

### Write paths

These four features give the model three new ways to write to disk: memory
files, skill files, and whatever tools an MCP server exposes. That is the
largest behavioural change in the batch.

Every one of them routes through the existing approval gate and
`wrapUntrusted`, rather than around it. `remember` is the single deliberate
exception, for the reason given in Section 3.

### Shared trust store

Section 1 needs the content-hash trust gate that
`src/personality-trust.ts` already implements. Rather than a second copy,
generalise it to `src/trust-store.ts` keyed by category
(`personality` | `mcp-server`), and have `PersonalityTrustStore` become a thin
wrapper. Existing `~/.robin/personality-trust.json` files migrate on first read.

## Out of scope

- MCP Streamable-HTTP transport, and MCP resources and prompts (tools only).
- Messaging gateways (Telegram, Discord, Slack, WhatsApp, Signal, Email).
- Remote execution backends (Docker, SSH, Modal, Daytona, Vercel Sandbox).
- Skills Hub publishing and discovery.
- Scheduled automations / cron.
- Semantic or embedding-based search. FTS5 only.
- Skills that self-improve during use. Creation only in this batch.
