# Up/down input history navigation

Date: 2026-08-07

## Goal

Let the up and down arrows walk back through lines already submitted this
session and return to the line currently being typed, the way a shell does.

## The keybinding conflict

Up and down are already bound. `src/repl/slash-prompt.ts` uses them to move the
selection in the slash-command popup.

They can coexist because the popup is only open when the buffer starts with
`/` and matches a command prefix. The rule is therefore:

- **Popup open** — up/down move the popup selection. Unchanged behaviour.
- **Popup closed** — up/down move through input history.

No keybinding is lost and no modifier is introduced.

## Cursor model

History is an array ordered oldest to newest. A cursor indexes it, with one
value past the end reserved:

```
cursor === history.length   →  "the present" (the line being typed)
cursor === history.length-1 →  most recent entry
cursor === 0                →  oldest entry
```

Behaviour, with the popup closed:

- **`up`**
  - Does nothing when history is empty.
  - When leaving the present (`cursor === history.length`), stash the current
    buffer in `draft` first.
  - Move to `max(cursor - 1, 0)` and write that entry into the buffer.
  - Stops at the oldest entry. **No wraparound** — jumping from the oldest
    entry back to the newest gives no signal that the end was reached and reads
    as the recall having glitched.
- **`down`**
  - Does nothing when already at the present.
  - Move to `cursor + 1`. If that lands on `history.length`, restore `draft`;
    otherwise write that entry.
- **Any other keypress** — when the cursor is at the present, update `draft` to
  the current buffer, keeping the stash in sync so a later up/down round-trip
  restores what the user actually had typed.

Typing while on a recalled entry leaves the cursor where it is. Moving away
afterwards discards the edit. This matches the common shell default closely
enough, and per-entry edit buffers are not worth the complexity.

### The jam this model has to avoid

Writing a recalled entry into the buffer must **not** re-run the slash-command
filter. A recalled `/random` would otherwise reopen the popup, and the user's
next `up` would move the popup selection instead of continuing back through
history — recall would jam after a single step.

A history write therefore clears `matches` explicitly. The popup opens in
response to typing only.

## Components

### `src/repl/input-history.ts` (new)

Pure, no I/O:

```ts
export const MAX_INPUT_HISTORY: number; // 200

export function addToInputHistory(history: string[], line: string): string[];
```

Returns a new array. Skips lines that are empty or whitespace-only, and skips a
line identical to the current newest entry (consecutive duplicates only —
pressing `/random` three times in a row leaves one entry, but an older
occurrence further back is preserved so the sequence of work stays readable).
Trims to the newest `MAX_INPUT_HISTORY` entries; the cap bounds memory in a long
session, and history is session-only so nothing is lost across restarts that
was not already going to be.

### `src/repl/slash-prompt.ts` (modified)

The prompt gains config:

```ts
createPrompt<string, { history?: string[] }>(...)
```

`history` defaults to `[]`. Two new state values: `cursor` (initialised to
`history.length`) and `draft` (initialised to `''`).

Buffer writes reuse the pattern the tab-completion branch already uses and
that the existing tests already exercise:

```ts
rl.clearLine(0);
rl.write(text);
setValue(rl.line);
```

`readSlashAwareLine(history: string[] = [])` forwards it.

### `src/repl/run-repl.ts` (modified)

Owns the array. It is named `inputHistory`, **not** `history` — `history` is
already the conversation message array in that function, and shadowing it would
be a live bug waiting to happen.

Every line returned by `readSlashAwareLine` is appended via
`addToInputHistory` before it is parsed, so a command that ends the loop
(`/exit`) is still recorded consistently with the rest.

History is session-only and never written to disk. Prompt text carries the same
sensitive material as the transcripts, and this adds no new file for it to sit
in.

## Testing

`tests/repl/input-history.test.ts` — the pure function: appends, ignores empty
and whitespace-only lines, collapses consecutive duplicates, preserves a
non-consecutive repeat, enforces the cap by dropping oldest first, and does not
mutate its input.

`tests/repl/slash-prompt.test.ts` — through the existing fake-TTY harness,
driving real escape sequences (`[A` for up, `[B` for down):

- `up` with history recalls the newest entry.
- Two `up` presses reach the second-newest.
- `up` at the oldest entry stays there rather than wrapping.
- `down` returns toward the present.
- `down` at the present restores an unsent draft typed before the first `up`.
- `up` with empty history leaves the buffer untouched.
- Recalling an entry that is a slash command does not open the popup, and a
  following `up` continues through history rather than moving a selection.
- With the popup open, up/down still move the popup selection and do not touch
  history.

## Out of scope

- Persisting history across restarts.
- Reverse incremental search (Ctrl-R).
- Per-entry edit buffers.
- Deduplicating non-consecutive repeats.
