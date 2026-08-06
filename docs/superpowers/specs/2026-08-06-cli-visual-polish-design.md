# CLI Visual Polish: Banner & Chat Layout

Date: 2026-08-06

## Goal

`ai-term-chat` currently prints plain, unstyled text: a single `chalk.cyan`
"Connected to X (model)" line at startup, a bare `assistant> ` prefix for
replies, and a bare `> ` readline prompt. This spec adds a small ASCII banner
on startup and a lightweight, consistent visual style to the chat loop —
purely presentational, no behavior changes.

## Non-goals

- No new npm dependencies (no `figlet`, `boxen`, `gradient-string`). Effects
  are built with `chalk.hex()` and hand-rolled box-drawing characters.
- No changes to `agent-loop.ts`, providers, or tool execution logic.
- No changes to command parsing, history handling, or REPL control flow.

## Design

### 1. Shared theme module — `src/ui/theme.ts`

A small module other UI code imports from, so colors and box-drawing aren't
duplicated across files:

- A short palette of cyan→blue hex shades (e.g. `#22d3ee`, `#38bdf8`,
  `#60a5fa`, `#818cf8`) exposed as a `gradientText(text: string): string`
  helper that colors each character by stepping through the palette.
- Semantic color exports built on existing chalk styles: `userColor`,
  `assistantColor`, `errorColor`, `mutedColor` (dim/gray for dividers and
  subtitles).
- A `box(lines: string[]): string` helper that wraps given lines in a
  rounded box-drawing border (`╭─╮│╰─╯`), sized to the longest line. Used for
  tool-confirmation prompts.
- A `divider(): string` helper returning a thin full-width-ish `─` line in
  muted color, used between chat turns.

### 2. Startup banner — `src/ui/banner.ts`

Two exported functions:

- `printBanner(): void` — prints the small ASCII mark and wordmark once,
  before any provider/model selection happens. Output:

  ```
     ╭───────╮
     │  >_   │   a i - t e r m - c h a t
     ╰───────╯   chat with AI, right from your terminal

  ```

  The box and `>_` glyph use `gradientText`/theme colors; the wordmark and
  tagline use muted/bright variants. Letter-spacing on the wordmark is a
  fixed join with single spaces between characters.

- `printConnectionLine(providerName: string, model: string): void` — prints
  the "now connected" subtitle, replacing the current
  `console.log(chalk.cyan(...))` line in `run-repl.ts`:

  ```
     ── Copilot · gpt-4.1 ──────────────────────
  ```

  Left-padded to align under the banner box; dash fill extends to a fixed
  terminal-friendly width (e.g. 48 cols, not full terminal width — keeps it
  simple and avoids `process.stdout.columns` edge cases).

### 3. Wiring

- `src/cli.ts`: `startChat()` calls `printBanner()` as its first line, before
  `pickProvider()`/`ensureAuthenticated()`/`pickModel()` — so the banner is
  the first thing a user sees, before any prompts.
- `src/repl/run-repl.ts`: replace the existing
  `console.log(chalk.cyan(\`Connected to...\`))` call with
  `printConnectionLine(provider.name, model)`. This call also re-runs after
  `/model` and `/provider` switches (same call sites that already reset
  `history`), so the subtitle reflects the active connection after a switch.

### 4. Chat loop restyle (`src/repl/run-repl.ts`)

- **User prompt**: `rl.question('> ')` becomes `rl.question(userColor('> '))`.
- **Turn separation**: print `divider()` before each `rl.question` prompt
  (except the very first, right after the banner/subtitle) so turns are
  visually separable in scrollback.
- **Assistant marker**: replace `chalk.magenta('assistant> ')` with
  `assistantColor('» ')` — shorter, less noisy than repeating the word
  "assistant" every turn.
- **Tool confirmation**: the existing `confirm` callback currently does
  `rl.question(chalk.yellow(\`\n${message} (y/n) \`))`. Wrap `message` (which
  already contains the action description, e.g. "Write to hello.txt?" plus
  the file/command content) through `box([...])` before asking, so
  write/run confirmations stand out clearly from normal chat text. The
  `(y/n)` prompt itself stays as a plain trailing line under the box, still
  in yellow, since it's an active input prompt, not framed content.
- **Errors**: prefix with `✖ ` glyph: `errorColor(\`✖ ${err.message}\`)`
  instead of the current `chalk.red(\`\nError: ...\`)`.

## Testing

This is presentational-only. Verification is manual:
- Run `npm run build && node dist/cli.js chat ollama` (or `copilot` if
  logged in) and visually confirm: banner renders once at startup, dashes/
  colors look right in both light and dark terminal backgrounds, prompts,
  markers, dividers, and boxed tool-confirmation render correctly, `/model`
  and `/provider` reprint the connection subtitle.
- No unit tests are added for ASCII layout strings — they're not meaningful
  to assert on exactly, and existing tests (`tests/`) covering command
  parsing / agent loop / tools are unaffected since none of those files
  change.

## Files touched

- New: `src/ui/theme.ts`
- New: `src/ui/banner.ts`
- Edit: `src/cli.ts` (add `printBanner()` call)
- Edit: `src/repl/run-repl.ts` (banner subtitle, prompt/marker/divider/error
  styling, boxed tool confirmation)
