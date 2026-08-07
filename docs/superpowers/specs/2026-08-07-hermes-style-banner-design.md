# Hermes-style startup screen

Date: 2026-08-07

## Goal

Replace Robin's current startup output — block wordmark, cowl, two tagline
lines, connection rule — with a denser screen modelled on the Hermes Agent
banner: a gradient wordmark above a single bordered panel that shows session
context on the left and Robin's commands and tools on the right.

Reference: the Hermes Agent startup screenshot in
<https://dev.to/paimon_573760ccaa1b3492b4/nous-research-hermes-agent-setup-and-tutorial-guide-2glg>.
What it does, and what this design borrows:

- A full-width block wordmark with a vertical gradient. Borrowed.
- One bordered panel with the version label sunk into the top border,
  right-aligned. Borrowed.
- Two columns inside: ASCII mascot plus dim session metadata on the left,
  headed lists of capabilities on the right, closing with a dim stat line.
  Borrowed.
- Amber palette and extruded "brick" letterforms. Not borrowed — Robin keeps
  its cyan-to-indigo gradient and its existing solid-block glyphs.

Hermes fills its right column with 30 tools across 20 toolsets and 74 skills.
Robin has 3 tools, 12 slash commands, 6 providers, and skills that are
user-saved system-prompt presets (often none). The right column therefore
carries commands and tools, which is the densest real content Robin has.

## Layout

```
  ██████ ... ROBIN wordmark, 9 rows, vertical cyan→indigo gradient

  ╭──────────────────────────────────── Robin v0.1.0 ─╮
  │        /\       /\          Commands              │
  │       /  \_____/  \           /help    list commands
  │      /   ╭───────╮  \         /model   switch model on the current provider
  │     /    │  ●  ●  │   \       ...  (12 rows)
  │    █     │         │    █
  │     \    ╰───────╯    /     Tools  (enabled)
  │      \_______________/        read_file    read a file from disk
  │          ▀▀▀▀▀▀▀▀▀            write_file   ...
  │                               run_command  ...
  │   openai · gpt-4o
  │   ~/Personal/ai-term-chat     3 tools · 12 commands · /help for commands
  │   Session: 20260807_1432_a3f1
  │
  │   Robin is a terminal agent that lets you run your AI.
  │   built by Samukelo "Batman" Magagula
  ╰───────────────────────────────────────────────────╯

  Type your message, or / for commands.
```

### Colors

The existing `GRADIENT` in `src/ui/theme.ts` (`#22d3ee`, `#38bdf8`, `#60a5fa`,
`#818cf8`) drives everything new. Nothing else in the app is recolored.

- Wordmark: each of the 9 rows takes the gradient stop at
  `GRADIENT[Math.floor(row / 9 * GRADIENT.length)]`, clamped to the last index,
  so the mark fades top to bottom. This replaces the current
  `chalk.whiteBright`.
- Panel border and version label: `GRADIENT[0]`.
- Section headings (`Commands`, `Tools`): bold, `GRADIENT[2]`.
- Command names, tool names: `chalk.whiteBright`.
- Descriptions, metadata lines, tagline, author, stat footer: `mutedColor`.
- The cowl keeps its current colors, red lenses included.

`gradientText` in `theme.ts` colors per character horizontally and is used
elsewhere; it is not used by the banner and is left alone. The wordmark's
row-wise gradient is computed in `src/ui/wordmark.ts`.

### Version label

Read `version` from `package.json` at module load in `src/ui/banner.ts`, via
`createRequire(import.meta.url)` since the project is ESM. Rendered as
`Robin v0.1.0`. If the read throws, the title falls back to `Robin` with no
version — the banner must never crash startup.

## Timing

`printBanner()` currently runs at `src/cli.ts:60`, before the provider and
model pickers. The panel needs provider and model, which do not exist at that
point.

`printBanner()` moves into `runRepl`, replacing the `printConnectionLine` call
at `src/repl/run-repl.ts:61`. The picker prompts now appear before any
branding; the banner prints once connected. This is accepted.

`printConnectionLine` is **kept** and still exported. Its three switch-time
call sites in `run-repl.ts` (lines 110, 121, 347 at time of writing) are live
status updates after a provider or model change, not startup output, and they
keep working unchanged. Only the startup call at line 61 goes away.

## Components

### `src/ui/panel.ts` (new)

Generic, Robin-agnostic. Knows about borders, columns, padding, and
truncation; knows nothing about cowls, commands, or tools.

```ts
export interface PanelOptions {
  title: string;
  left: string[];
  right: string[];
  width: number;
  leftWidth: number;
  borderColor: (s: string) => string;
}

export function renderPanel(options: PanelOptions): string[];
```

Behavior:

- Returns the panel as an array of lines, top border through bottom border. It
  does not print.
- Top border: `╭`, then `─` fill, then ` ` + title + ` `, then `─`, then `╮`,
  right-aligned so exactly one `─` sits between the title and `╮`. If the title
  does not fit in `width - 4`, it is dropped and the border is plain.
- Body rows: `│ ` + left cell padded to `leftWidth` + right cell padded to the
  remainder + ` │`. The row count is `max(left.length, right.length)`; the
  shorter column is padded with empty strings.
- A cell longer than its own column width is truncated to that column's width
  minus 1 visible characters, plus `…`.
- Truncation and padding must measure **visible** width, ignoring ANSI escape
  sequences. A local `visibleLength(s)` strips `\x1b\[[0-9;]*m` before
  measuring. Getting this wrong is the most likely way for the panel to come
  out ragged, so it is tested directly.

### `src/ui/wordmark.ts` (new)

`ROBIN_LETTERS` and the row assembly move here from `banner.ts`, unchanged
except for the gradient coloring described above.

```ts
export const WORDMARK_WIDTH: number; // 49
export function buildWordmark(): string[];      // 9 gradient rows
export function buildPlainWordmark(): string[]; // ['ROBIN'] gradient-colored
```

### `src/ui/cowl.ts` (new)

The mask art moves here from `banner.ts`, unchanged.

```ts
export const COWL_WIDTH: number; // 26
export function buildCowl(): string[]; // 8 rows
```

The cowl is no longer centered under the wordmark — inside the panel it is left
column content, so `buildCowl()` returns rows with no leading indent and the
panel handles placement.

### `src/session-id.ts` (new)

```ts
export function newSessionId(): string;
```

Returns `YYYYMMDD_HHmm_` plus 6 lowercase hex characters from
`crypto.randomBytes(3)`, e.g. `20260807_1432_a3f1c9`. Local time, zero-padded.
The id is generated once in `runRepl` and used only for display; nothing reads
it back.

### `src/ui/banner.ts` (rewritten)

Assembles the pieces. This is the only new module that knows about Robin's
content.

```ts
export interface BannerInfo {
  providerName: string;
  model: string;
  cwd: string;
  sessionId: string;
  toolsEnabled: boolean;
}

export function printBanner(info: BannerInfo): void;
export function printConnectionLine(providerName: string, model: string): void;
```

Left column, in order: cowl rows, blank, `provider · model`, home-shortened
cwd, `Session: <id>`, blank, tagline, author.

Right column, in order: `Commands` heading; one row per entry in
`SLASH_COMMANDS` from `src/repl/slash-prompt.ts`, formatted as the name padded
to 10 followed by the description; blank; `Tools` heading with ` (enabled)` or
` (disabled)` appended per `info.toolsEnabled`; one row per entry in
`TOOL_DEFINITIONS` from `src/tools/definitions.ts`, name padded to 13 followed
by the description; blank; the stat line
`3 tools · 12 commands · /help for commands` with counts taken from the arrays,
not hardcoded.

Command and tool lists are read from the existing exports. Neither list is
duplicated in the banner. Both `SLASH_COMMANDS` and `TOOL_DEFINITIONS` are
already exported and their shapes do not change.

`printBanner` prints, in order: a blank line, the wordmark, a blank line, the
panel, a blank line. The `Type your message, or / for commands.` line stays
where it is in `run-repl.ts` and is not part of the banner.

Home-shortening: if `cwd` starts with `os.homedir()`, that prefix is replaced
with `~`. Path separators are left as the platform produced them.

## Sizing

- `width = min(process.stdout.columns ?? 80, 100)`, floored at 60.
- `leftWidth = COWL_WIDTH + 3` (29).
- Below 90 columns the panel stacks. `renderPanel` is still used, called with
  `left: [...leftLines, '', ...rightLines]`, `right: []`, and
  `leftWidth = width - 4`, so everything renders as one full-width column.
- Below 51 columns (`WORDMARK_WIDTH + 2`) the block wordmark is replaced by
  `buildPlainWordmark()`.
- `process.stdout.columns` is `undefined` when output is piped; treat as 80,
  which lands in the stacked layout.

## Testing

There are no banner tests today. New tests under `tests/ui/`:

- `panel.test.ts` — column alignment at several widths; right column padded
  when shorter than left and vice versa; truncation with `…`; ANSI sequences
  not counted toward width; title right-aligned with one trailing `─`; title
  dropped when too long; every returned line the same visible width.
- `wordmark.test.ts` — 9 rows; every row the same visible width;
  `WORDMARK_WIDTH` matches actual visible width; plain variant is one row.
- `banner.test.ts` — with `chalk.level` forced to 0 and `console.log`
  captured: output contains every slash command name and every tool name; the
  stat line counts match the source arrays; `(disabled)` appears when
  `toolsEnabled` is false; session id, model, and provider name all appear;
  a cwd under the home directory is rendered with a leading `~`; no line
  exceeds the panel width; a 40-column terminal produces the plain wordmark
  and stacked layout without throwing.
- `session-id.test.ts` — matches `/^\d{8}_\d{4}_[0-9a-f]{6}$/`; two successive
  calls differ.

`printConnectionLine` behavior is unchanged and needs no new tests.

## Out of scope

- Recoloring anything outside the banner. `theme.ts` gains no changes beyond
  whatever export the wordmark needs.
- Listing skills or providers in the panel.
- Any change to how `printConnectionLine` renders at switch time.
- Redrawing the letterforms in the extruded Hermes style.
