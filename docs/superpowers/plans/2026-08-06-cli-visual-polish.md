# CLI Visual Polish (Banner & Chat Layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small ASCII startup banner and a consistent visual style (colors, dividers, boxed confirmations) to the `ai-term-chat` REPL, with zero new dependencies.

**Architecture:** Two new presentational modules under `src/ui/` — `theme.ts` (shared colors/box/divider helpers built on `chalk`) and `banner.ts` (startup banner + connection subtitle, built on `theme.ts`). `src/cli.ts` and `src/repl/run-repl.ts` are edited to call into these modules instead of their current inline `chalk.*` calls. No changes to agent loop, providers, tools, or command parsing.

**Tech Stack:** TypeScript, Node.js, `chalk` (already a dependency). No new npm packages.

## Global Constraints

- No new npm dependencies — use only `chalk` (already installed) plus hand-rolled ASCII/box-drawing characters.
- Do not modify `src/agent-loop.ts`, `src/providers/*`, `src/tools/*`, or `src/repl/parse-command.ts` — this work is presentational only.
- No unit tests for ASCII layout strings (per spec) — verification is `npm run build` (type-check) plus a manual smoke run of the REPL for the final integration task.
- Spec reference: `docs/superpowers/specs/2026-08-06-cli-visual-polish-design.md`.

---

### Task 1: Theme module (`src/ui/theme.ts`)

**Files:**
- Create: `src/ui/theme.ts`

**Interfaces:**
- Consumes: `chalk` (default export) from the `chalk` package.
- Produces (used by Task 2 and Task 3):
  - `gradientText(text: string): string`
  - `userColor: (text: string) => string` (a `chalk` styler)
  - `assistantColor: (text: string) => string`
  - `errorColor: (text: string) => string`
  - `mutedColor: (text: string) => string`
  - `box(lines: string[]): string`
  - `divider(): string`

- [ ] **Step 1: Write `src/ui/theme.ts`**

```ts
import chalk from 'chalk';

const GRADIENT = ['#22d3ee', '#38bdf8', '#60a5fa', '#818cf8'];

export function gradientText(text: string): string {
  return text
    .split('')
    .map((char, i) => chalk.hex(GRADIENT[i % GRADIENT.length])(char))
    .join('');
}

export const userColor = chalk.cyanBright;
export const assistantColor = chalk.hex('#818cf8');
export const errorColor = chalk.red;
export const mutedColor = chalk.gray;

export function box(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const top = mutedColor(`╭${'─'.repeat(width + 2)}╮`);
  const bottom = mutedColor(`╰${'─'.repeat(width + 2)}╯`);
  const middle = lines.map((l) => `${mutedColor('│ ')}${l.padEnd(width)}${mutedColor(' │')}`);
  return [top, ...middle, bottom].join('\n');
}

const DIVIDER_WIDTH = 48;

export function divider(): string {
  return mutedColor('─'.repeat(DIVIDER_WIDTH));
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: compiles with no errors (this adds a new file; nothing imports it yet, so `tsc` just needs to accept the file's own syntax/types).

- [ ] **Step 3: Commit**

```bash
git add src/ui/theme.ts
git commit -m "feat: add shared CLI theme helpers (colors, box, divider)"
```

---

### Task 2: Banner module (`src/ui/banner.ts`)

**Files:**
- Create: `src/ui/banner.ts`

**Interfaces:**
- Consumes: `gradientText`, `mutedColor` from `../ui/theme.js` (Task 1).
- Produces (used by Task 3):
  - `printBanner(): void`
  - `printConnectionLine(providerName: string, model: string): void`

- [ ] **Step 1: Write `src/ui/banner.ts`**

```ts
import { gradientText, mutedColor } from './theme.js';

export function printBanner(): void {
  const lines = [
    '',
    `   ${gradientText('╭───────╮')}`,
    `   ${gradientText('│  >_   │')}   ${gradientText('a i - t e r m - c h a t')}`,
    `   ${gradientText('╰───────╯')}   ${mutedColor('chat with AI, right from your terminal')}`,
    '',
  ];
  console.log(lines.join('\n'));
}

const SUBTITLE_WIDTH = 44;

export function printConnectionLine(providerName: string, model: string): void {
  const label = `${providerName} · ${model}`;
  const fillLength = Math.max(SUBTITLE_WIDTH - label.length - 4, 0);
  console.log(`   ${mutedColor('──')} ${label} ${mutedColor('─'.repeat(fillLength))}`);
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/banner.ts
git commit -m "feat: add CLI startup banner and connection subtitle"
```

---

### Task 3: Wire banner and theme into `cli.ts` and `run-repl.ts`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/repl/run-repl.ts`

**Interfaces:**
- Consumes: `printBanner`, `printConnectionLine` from `../ui/banner.js` (Task 2); `userColor`, `assistantColor`, `errorColor`, `divider`, `box` from `../ui/theme.js` (Task 1).
- Produces: nothing new (this is the final integration task).

- [ ] **Step 1: Edit `src/cli.ts` to print the banner at the start of a chat session**

Add the import near the top (after the existing imports):

```ts
import { printBanner } from './ui/banner.js';
```

Change `startChat` from:

```ts
async function startChat(providerId?: string): Promise<void> {
  const provider = providerId ? getProvider(providerId) : await pickProvider();
  await ensureAuthenticated(provider);
  const model = await pickModel(provider);
  await runRepl({ provider, model, pickModel, pickProvider });
}
```

to:

```ts
async function startChat(providerId?: string): Promise<void> {
  printBanner();
  const provider = providerId ? getProvider(providerId) : await pickProvider();
  await ensureAuthenticated(provider);
  const model = await pickModel(provider);
  await runRepl({ provider, model, pickModel, pickProvider });
}
```

- [ ] **Step 2: Edit `src/repl/run-repl.ts` — imports and connection line**

Replace the import block:

```ts
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Provider, Message } from '../providers/types.js';
import { parseCommand } from './parse-command.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
```

with:

```ts
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Provider, Message } from '../providers/types.js';
import { parseCommand } from './parse-command.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { printConnectionLine } from '../ui/banner.js';
import { userColor, assistantColor, errorColor, divider, box } from '../ui/theme.js';
```

Replace:

```ts
  console.log(chalk.cyan(`Connected to ${provider.name} (${model}). Type your message, /help for commands.`));
```

with:

```ts
  printConnectionLine(provider.name, model);
  console.log(chalk.gray('Type your message, /help for commands.'));
```

- [ ] **Step 3: Edit `src/repl/run-repl.ts` — turn divider and user prompt**

Replace the `while (true) {` loop opening:

```ts
  while (true) {
    const line = await rl.question('> ');
    const cmd = parseCommand(line);
```

with:

```ts
  let isFirstTurn = true;

  while (true) {
    if (!isFirstTurn) {
      console.log(divider());
    }
    isFirstTurn = false;

    const line = await rl.question(userColor('> '));
    const cmd = parseCommand(line);
```

- [ ] **Step 4: Edit `src/repl/run-repl.ts` — reprint connection line on `/model` and `/provider`**

Replace:

```ts
    if (cmd.type === 'model') {
      model = await deps.pickModel(provider);
      history = [];
      continue;
    }

    if (cmd.type === 'provider') {
      provider = await deps.pickProvider();
      model = await deps.pickModel(provider);
      history = [];
      continue;
    }
```

with:

```ts
    if (cmd.type === 'model') {
      model = await deps.pickModel(provider);
      history = [];
      printConnectionLine(provider.name, model);
      continue;
    }

    if (cmd.type === 'provider') {
      provider = await deps.pickProvider();
      model = await deps.pickModel(provider);
      history = [];
      printConnectionLine(provider.name, model);
      continue;
    }
```

- [ ] **Step 5: Edit `src/repl/run-repl.ts` — assistant marker, boxed confirmation, error styling**

Replace:

```ts
    const historyLengthBeforeTurn = history.length;
    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(chalk.magenta('assistant> '));
    try {
      const newMessages = await runAgentTurn(provider, model, history, TOOL_DEFINITIONS, {
        onText: (text) => process.stdout.write(text),
        executeTool,
        confirm: async (message) => {
          const answer = await rl.question(chalk.yellow(`\n${message} (y/n) `));
          return /^y(es)?$/i.test(answer.trim());
        },
      });
      history.push(...newMessages);
      process.stdout.write('\n');
    } catch (err) {
      // Drop the user message so a failed turn doesn't leave two consecutive
      // user messages in the history sent to the API next time.
      history.length = historyLengthBeforeTurn;
      console.log(chalk.red(`\nError: ${(err as Error).message}`));
    }
```

with:

```ts
    const historyLengthBeforeTurn = history.length;
    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(assistantColor('» '));
    try {
      const newMessages = await runAgentTurn(provider, model, history, TOOL_DEFINITIONS, {
        onText: (text) => process.stdout.write(text),
        executeTool,
        confirm: async (message) => {
          console.log(`\n${box(message.split('\n'))}`);
          const answer = await rl.question(chalk.yellow('(y/n) '));
          return /^y(es)?$/i.test(answer.trim());
        },
      });
      history.push(...newMessages);
      process.stdout.write('\n');
    } catch (err) {
      // Drop the user message so a failed turn doesn't leave two consecutive
      // user messages in the history sent to the API next time.
      history.length = historyLengthBeforeTurn;
      console.log(errorColor(`\n✖ ${(err as Error).message}`));
    }
```

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Step 7: Run the existing test suite**

Run: `npm test`
Expected: all existing tests still pass (none of them cover `cli.ts`/`run-repl.ts` output formatting, so this just confirms nothing else broke).

- [ ] **Step 8: Manual smoke test**

Run: `node dist/cli.js chat ollama` (requires `ollama serve` running with a pulled model; use `chat copilot` instead if already logged in to Copilot).

Confirm visually:
- The banner (box + `>_` + wordmark + tagline) prints once, before the model/provider is even known if no provider arg was given, or immediately if one was.
- The `── <provider> · <model> ──...` subtitle line prints once connected.
- Typing a message shows a cyan `>` prompt and a `»` assistant marker for the reply.
- A `─` divider line appears before the second and later prompts, not before the first.
- Sending a message that triggers `write_file` or `run_command` shows the confirmation text inside a bordered box, with `(y/n)` below it.
- Triggering an error (e.g. disconnect Ollama mid-session and send a message) shows a red `✖ ...` line.
- `/model` and `/provider` reprint the connection subtitle with the new provider/model.

Exit with `/exit`.

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts src/repl/run-repl.ts
git commit -m "feat: wire CLI banner and theme into startup and chat loop"
```

---

## Self-Review Notes

- **Spec coverage:** Theme module (§1) → Task 1. Banner + connection line (§2) → Task 2. Wiring order in `cli.ts` (§3) → Task 3 Step 1. Chat loop restyle — prompt, divider, marker, boxed confirmation, error glyph (§4) → Task 3 Steps 3–5. Manual-only testing per spec's Testing section → Task 3 Steps 7–8.
- **Placeholder scan:** No TBD/TODO markers; every step has literal code or an exact manual-verification checklist.
- **Type consistency:** `printBanner`/`printConnectionLine` signatures match between Task 2 (definition) and Task 3 (call sites). `box`, `divider`, `userColor`, `assistantColor`, `errorColor`, `mutedColor`, `gradientText` names and signatures match between Task 1 (definition) and Tasks 2–3 (usage).
