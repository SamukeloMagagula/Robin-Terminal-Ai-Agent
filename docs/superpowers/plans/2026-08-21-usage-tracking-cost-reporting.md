# Usage Tracking and Cost Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Robin a persistent, cross-provider, cross-session record of
token usage and estimated cost, readable via `/usage` in the REPL and a new
`robin usage` CLI command.

**Architecture:** A new `UsageLog` (JSONL, one line per turn, modeled on
`src/autonomy/audit.ts`'s `AuditLog`) is written from inside `runTurn`
(`src/repl/run-turn.ts`) so both REPL turns and workflow turns are captured
by one code path. A static per-provider pricing table converts tokens to an
estimated dollar cost at write time. A pure aggregation function turns the
log into day/week/month/provider totals, rendered by a new function
alongside the existing OpenRouter renderer.

**Tech Stack:** TypeScript, Node.js `fs.promises`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-usage-tracking-cost-reporting-design.md`

## Global Constraints

- Usage log path: `<profile-home>/usage/usage.jsonl`, where profile-home
  comes from `robinHome()` in `src/profile.ts`.
- Directories created with `{ recursive: true, mode: 0o700 }`; the log file
  written with `mode: 0o600` — matches `AuditLog`'s handling of local
  activity records.
- A write failure to the usage log must never throw out of `runTurn` or
  delay the turn it's recording — append is fire-and-forget (`void
  usageLog.append(entry)`), exactly how `governance.audit.append` is already
  called in `src/gateway/approvals.ts:228`.
- OpenRouter is never priced from the static table — it keeps using its own
  live billed-$ API (`src/usage/openrouter-usage.ts`). The static table has
  no `openrouter` entry, ever.
- Copilot, Ollama, and local always resolve to `estimatedCostUsd: null` —
  never a fabricated dollar figure for a flat-subscription or self-hosted
  provider.
- UTC week starts Monday, matching the convention already used for
  OpenRouter's `usage_weekly` in `render-usage.ts`.

---

### Task 1: Pricing table

**Files:**
- Create: `src/usage/pricing.ts`
- Test: `tests/usage/pricing.test.ts`

**Interfaces:**
- Produces: `ModelPrice { match: string; inputPerMillion: number; outputPerMillion: number }`,
  `PRICING: Record<string, ModelPrice[]>`,
  `estimateCost(providerId: string, model: string, usage: TokenUsage): number | null`
  — consumed by Task 5 (`run-turn.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/usage/pricing.test.ts
import { describe, it, expect } from 'vitest';
import { estimateCost, PRICING } from '../../src/usage/pricing';

describe('estimateCost', () => {
  it('prices an exact model match', () => {
    // claude-sonnet-5: $3/M input, $15/M output (see PRICING table)
    const cost = estimateCost('anthropic', 'claude-sonnet-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 + 15, 5);
  });

  it('prices a versioned model by prefix match', () => {
    const cost = estimateCost('anthropic', 'claude-sonnet-5-20260201', {
      inputTokens: 500_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(1.5, 5);
  });

  it('returns null for a model with no pricing entry', () => {
    expect(
      estimateCost('anthropic', 'some-future-model', { inputTokens: 100, outputTokens: 100 })
    ).toBeNull();
  });

  it('returns null for providers with no per-token price: copilot, ollama, local', () => {
    for (const providerId of ['copilot', 'ollama', 'local']) {
      expect(
        estimateCost(providerId, 'anything', { inputTokens: 100, outputTokens: 100 })
      ).toBeNull();
    }
  });

  it('never has an openrouter entry — it prices from its own live API instead', () => {
    expect(PRICING.openrouter).toBeUndefined();
  });

  it('computes a fractional cost for small token counts', () => {
    const cost = estimateCost('gemini', 'gemini-2.5-flash', {
      inputTokens: 1000,
      outputTokens: 500,
    });
    // 1000/1e6 * 0.30 + 500/1e6 * 2.50 = 0.0003 + 0.00125
    expect(cost).toBeCloseTo(0.00155, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/pricing.test.ts`
Expected: FAIL — `Cannot find module '../../src/usage/pricing'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/usage/pricing.ts
import type { TokenUsage } from '../providers/types.js';

export interface ModelPrice {
  /** Matches a model id by exact string, or as a prefix (e.g. a dated snapshot suffix). */
  match: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Hand-maintained snapshot of published per-token pricing, in USD per
 * million tokens. Provider price pages are the source of truth — this will
 * drift as they change prices, the same tradeoff every hardcoded price
 * table makes. Update this file when a provider's pricing changes.
 *
 * `openrouter` is deliberately absent: it reports real, live billed spend
 * via its own account API (`openrouter-usage.ts`), and estimating on top of
 * that would be a second, worse answer to a question already answered
 * correctly. `copilot`, `ollama`, and `local` are absent too — a flat
 * subscription and self-hosted runs have no meaningful per-token price.
 */
export const PRICING: Record<string, ModelPrice[]> = {
  anthropic: [
    { match: 'claude-opus-5', inputPerMillion: 15, outputPerMillion: 75 },
    { match: 'claude-opus-4-8', inputPerMillion: 15, outputPerMillion: 75 },
    { match: 'claude-sonnet-5', inputPerMillion: 3, outputPerMillion: 15 },
    { match: 'claude-haiku-4-5', inputPerMillion: 0.8, outputPerMillion: 4 },
  ],
  gemini: [
    { match: 'gemini-2.5-pro', inputPerMillion: 1.25, outputPerMillion: 10 },
    { match: 'gemini-2.5-flash', inputPerMillion: 0.3, outputPerMillion: 2.5 },
  ],
};

/**
 * Longest match wins, so a specific entry (if the table ever has two
 * entries where one prefixes the other) beats a shorter, more general one.
 */
function findPrice(providerId: string, model: string): ModelPrice | null {
  const entries = PRICING[providerId];
  if (!entries) return null;
  let best: ModelPrice | null = null;
  for (const entry of entries) {
    if (model === entry.match || model.startsWith(entry.match)) {
      if (!best || entry.match.length > best.match.length) best = entry;
    }
  }
  return best;
}

export function estimateCost(providerId: string, model: string, usage: TokenUsage): number | null {
  const price = findPrice(providerId, model);
  if (!price) return null;
  return (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/usage/pricing.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/usage/pricing.ts tests/usage/pricing.test.ts
git commit -m "feat: static per-token pricing table for usage cost estimates"
```

---

### Task 2: UsageLog

**Files:**
- Create: `src/usage/usage-log.ts`
- Test: `tests/usage/usage-log.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `robinHome()` from `src/profile.ts`, already
  imported the same way in `src/autonomy/audit.ts`).
- Produces: `UsageEntry { ts, provider, model, inputTokens, outputTokens, estimatedCostUsd }`,
  `class UsageLog { append(entry): Promise<Error | undefined>; readAll(): Promise<UsageEntry[]> }`,
  `defaultUsageLogPath(): string` — consumed by Task 3 (report), Task 5
  (`run-turn.ts`), Task 6 (`/usage`), Task 7 (`robin usage`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/usage/usage-log.test.ts
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { UsageLog, type UsageEntry } from '../../src/usage/usage-log';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-usage-'));
  return path.join(dir, 'usage.jsonl');
}

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  ts: '2026-08-21T09:00:00.000Z',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 100,
  outputTokens: 20,
  estimatedCostUsd: 0.0006,
  ...overrides,
});

describe('UsageLog', () => {
  it('appends and reads back entries in order', async () => {
    const log = new UsageLog(await tempFile());
    await log.append(entry({ model: 'a' }));
    await log.append(entry({ model: 'b' }));

    const read = await log.readAll();
    expect(read.map((e) => e.model)).toEqual(['a', 'b']);
  });

  it('creates the parent directory on first append', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-usage-'));
    const file = path.join(dir, 'nested', 'usage.jsonl');
    const log = new UsageLog(file);

    await log.append(entry());

    expect(await fs.readFile(file, 'utf-8')).toContain('claude-sonnet-5');
  });

  it('returns an empty array when nothing has been recorded yet', async () => {
    expect(await new UsageLog(await tempFile()).readAll()).toEqual([]);
  });

  it('skips an unparseable trailing line rather than losing prior entries', async () => {
    const file = await tempFile();
    const log = new UsageLog(file);
    await log.append(entry({ model: 'a' }));
    await fs.appendFile(file, 'not json\n');

    expect(await log.readAll()).toHaveLength(1);
  });

  it('returns the error rather than throwing when the directory is a file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-usage-'));
    const blocked = path.join(dir, 'blocked');
    await fs.writeFile(blocked, '');

    const result = await new UsageLog(path.join(blocked, 'usage.jsonl')).append(entry());

    expect(result).toBeInstanceOf(Error);
  });

  it('keeps concurrent appends in the order they were issued, without awaiting each', async () => {
    const log = new UsageLog(await tempFile());

    void log.append(entry({ model: 'first' }));
    void log.append(entry({ model: 'second' }));
    void log.append(entry({ model: 'third' }));
    await log.flush();

    expect((await log.readAll()).map((e) => e.model)).toEqual(['first', 'second', 'third']);
  });

  it('preserves a null estimatedCostUsd through a round trip', async () => {
    const log = new UsageLog(await tempFile());
    await log.append(entry({ provider: 'ollama', estimatedCostUsd: null }));

    expect((await log.readAll())[0].estimatedCostUsd).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/usage-log.test.ts`
Expected: FAIL — `Cannot find module '../../src/usage/usage-log'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/usage/usage-log.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { robinHome } from '../profile.js';

export interface UsageEntry {
  ts: string; // ISO 8601
  provider: string; // Provider.id
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** null when this provider/model has no per-token price (Copilot, Ollama, local). */
  estimatedCostUsd: number | null;
}

export function defaultUsageLogPath(): string {
  return path.join(robinHome(), 'usage', 'usage.jsonl');
}

/**
 * Every turn's token cost, one JSON line each. Modeled directly on
 * `AuditLog` (`src/autonomy/audit.ts`): appends are chained on an internal
 * queue so concurrent turns can't interleave partial lines, and a write
 * failure is returned to the caller rather than thrown.
 */
export class UsageLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string = defaultUsageLogPath()) {}

  /** Resolves once every append issued so far has landed. For tests and shutdown. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async append(entry: UsageEntry): Promise<Error | undefined> {
    const write = this.queue.then(async (): Promise<Error | undefined> => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        return undefined;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    });
    this.queue = write;
    return write;
  }

  async readAll(): Promise<UsageEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf-8');
    } catch {
      return [];
    }
    const out: UsageEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageEntry);
      } catch {
        // A truncated final line from an interrupted write must not lose the rest.
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/usage/usage-log.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/usage/usage-log.ts tests/usage/usage-log.test.ts
git commit -m "feat: per-profile usage log, appended one line per turn"
```

---

### Task 3: Usage report aggregation

**Files:**
- Create: `src/usage/usage-report.ts`
- Test: `tests/usage/usage-report.test.ts`

**Interfaces:**
- Consumes: `UsageEntry` from `src/usage/usage-log.js` (Task 2).
- Produces: `UsageTotals { inputTokens, outputTokens, estimatedCostUsd, turns }`,
  `UsageReport { today, week, month, byProvider }`,
  `buildUsageReport(entries: UsageEntry[], now?: Date): UsageReport` —
  consumed by Task 4 (render) and Tasks 6/7 (surfaces).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/usage/usage-report.test.ts
import { describe, it, expect } from 'vitest';
import { buildUsageReport } from '../../src/usage/usage-report';
import type { UsageEntry } from '../../src/usage/usage-log';

const entry = (overrides: Partial<UsageEntry>): UsageEntry => ({
  ts: '2026-08-21T09:00:00.000Z',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 1000,
  outputTokens: 100,
  estimatedCostUsd: 0.0045,
  ...overrides,
});

// A Friday, so "this week" runs Monday 2026-08-17 through Sunday 2026-08-23.
const NOW = new Date('2026-08-21T12:00:00.000Z');

describe('buildUsageReport', () => {
  it('counts an entry from today in today, week, and month', () => {
    const report = buildUsageReport([entry({ ts: '2026-08-21T09:00:00.000Z' })], NOW);

    expect(report.today.turns).toBe(1);
    expect(report.week.turns).toBe(1);
    expect(report.month.turns).toBe(1);
    expect(report.today.inputTokens).toBe(1000);
    expect(report.today.estimatedCostUsd).toBeCloseTo(0.0045, 6);
  });

  it('excludes an entry from before this UTC week, but keeps it in the month', () => {
    // Monday 2026-08-17 00:00 UTC is the start of NOW's week — Sat 08-15 is not in it.
    const report = buildUsageReport([entry({ ts: '2026-08-15T09:00:00.000Z' })], NOW);

    expect(report.today.turns).toBe(0);
    expect(report.week.turns).toBe(0);
    expect(report.month.turns).toBe(1);
  });

  it('excludes an entry from last month entirely', () => {
    const report = buildUsageReport([entry({ ts: '2026-07-30T09:00:00.000Z' })], NOW);

    expect(report.month.turns).toBe(0);
  });

  it('excludes an entry from later the same day but a future turn is impossible — boundary is start of day UTC', () => {
    const report = buildUsageReport([entry({ ts: '2026-08-20T23:59:59.999Z' })], NOW);

    expect(report.today.turns).toBe(0);
    expect(report.week.turns).toBe(1);
  });

  it('sums known costs but counts a null-cost entry in tokens only', () => {
    const report = buildUsageReport(
      [
        entry({ provider: 'ollama', model: 'llama3', estimatedCostUsd: null, inputTokens: 500, outputTokens: 50 }),
        entry({ estimatedCostUsd: 0.01 }),
      ],
      NOW
    );

    expect(report.today.turns).toBe(2);
    expect(report.today.inputTokens).toBe(1500);
    expect(report.today.estimatedCostUsd).toBeCloseTo(0.01, 6);
  });

  it('breaks totals down by provider, all-time', () => {
    const report = buildUsageReport(
      [
        entry({ provider: 'anthropic', ts: '2026-07-01T00:00:00.000Z' }),
        entry({ provider: 'gemini', ts: '2026-08-21T00:00:00.000Z', estimatedCostUsd: 0.002 }),
      ],
      NOW
    );

    expect(report.byProvider.anthropic.turns).toBe(1);
    expect(report.byProvider.gemini.turns).toBe(1);
    expect(report.byProvider.gemini.estimatedCostUsd).toBeCloseTo(0.002, 6);
  });

  it('returns all-zero totals for an empty log', () => {
    const report = buildUsageReport([], NOW);

    expect(report.today).toEqual({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, turns: 0 });
    expect(report.byProvider).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/usage-report.test.ts`
Expected: FAIL — `Cannot find module '../../src/usage/usage-report'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/usage/usage-report.ts
import type { UsageEntry } from './usage-log.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  turns: number;
}

export interface UsageReport {
  today: UsageTotals;
  /** UTC week, Monday start — same convention as OpenRouter's usage_weekly. */
  week: UsageTotals;
  month: UsageTotals;
  byProvider: Record<string, UsageTotals>;
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, turns: 0 };
}

function add(totals: UsageTotals, entry: UsageEntry): void {
  totals.inputTokens += entry.inputTokens;
  totals.outputTokens += entry.outputTokens;
  totals.turns += 1;
  if (entry.estimatedCostUsd !== null) totals.estimatedCostUsd += entry.estimatedCostUsd;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Monday 00:00 UTC of the week containing `d`. Sunday counts as day 7, not day 0. */
function startOfUtcWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay(); // 1 = Monday .. 7 = Sunday
  day.setUTCDate(day.getUTCDate() - (weekday - 1));
  return day;
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function buildUsageReport(entries: UsageEntry[], now: Date = new Date()): UsageReport {
  const dayStart = startOfUtcDay(now);
  const weekStart = startOfUtcWeek(now);
  const monthStart = startOfUtcMonth(now);

  const report: UsageReport = {
    today: emptyTotals(),
    week: emptyTotals(),
    month: emptyTotals(),
    byProvider: {},
  };

  for (const entry of entries) {
    const ts = new Date(entry.ts);
    if (ts >= dayStart) add(report.today, entry);
    if (ts >= weekStart) add(report.week, entry);
    if (ts >= monthStart) add(report.month, entry);

    if (!report.byProvider[entry.provider]) report.byProvider[entry.provider] = emptyTotals();
    add(report.byProvider[entry.provider], entry);
  }

  return report;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/usage/usage-report.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/usage/usage-report.ts tests/usage/usage-report.test.ts
git commit -m "feat: aggregate the usage log into day/week/month/provider totals"
```

---

### Task 4: Render the local usage report

**Files:**
- Modify: `src/usage/render-usage.ts`
- Test: `tests/usage/render-usage.test.ts`

**Interfaces:**
- Consumes: `UsageReport`, `UsageTotals` from `src/usage/usage-report.js` (Task 3).
- Produces: `renderLocalUsageReport(report: UsageReport): string` — consumed
  by Task 6 (`/usage`) and Task 7 (`robin usage`).

- [ ] **Step 1: Write the failing test**

Append to `tests/usage/render-usage.test.ts`:

```typescript
import { renderLocalUsageReport } from '../../src/usage/render-usage';
import type { UsageReport } from '../../src/usage/usage-report';

function usageReport(overrides: Partial<UsageReport> = {}): UsageReport {
  const zero = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, turns: 0 };
  return {
    today: { ...zero },
    week: { ...zero },
    month: { ...zero },
    byProvider: {},
    ...overrides,
  };
}

describe('renderLocalUsageReport', () => {
  it('shows tokens and estimated cost for today, week, and month', () => {
    const report = usageReport({
      today: { inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 0.0045, turns: 3 },
      week: { inputTokens: 5000, outputTokens: 900, estimatedCostUsd: 0.02, turns: 10 },
      month: { inputTokens: 20000, outputTokens: 3000, estimatedCostUsd: 0.08, turns: 40 },
    });

    const out = strip(renderLocalUsageReport(report));

    expect(out).toContain('$0.0045');
    expect(out).toContain('$0.020');
    expect(out).toContain('$0.080');
    expect(out).toContain('1000');
    expect(out).toContain('3 turns');
  });

  it('breaks down by provider', () => {
    const report = usageReport({
      byProvider: {
        anthropic: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.001, turns: 1 },
        ollama: { inputTokens: 50, outputTokens: 10, estimatedCostUsd: 0, turns: 1 },
      },
    });

    const out = strip(renderLocalUsageReport(report));

    expect(out).toContain('anthropic');
    expect(out).toContain('ollama');
  });

  it('says so plainly when nothing has been recorded yet', () => {
    const out = strip(renderLocalUsageReport(usageReport()));

    expect(out).toContain('No usage recorded yet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage/render-usage.test.ts`
Expected: FAIL — `renderLocalUsageReport is not a function` (or `is not exported`)

- [ ] **Step 3: Write the implementation**

Append to `src/usage/render-usage.ts`:

```typescript
import type { UsageReport, UsageTotals } from './usage-report.js';

function totalsRow(label: string, totals: UsageTotals): string {
  const tokens = `${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out`;
  const cost = totals.estimatedCostUsd > 0 ? formatUsd(totals.estimatedCostUsd) : mutedColor('—');
  return row(label, `${tokens}  ·  ${cost}  ·  ${totals.turns} turn${totals.turns === 1 ? '' : 's'}`);
}

/**
 * Local, cross-provider usage — every provider Robin has ever recorded a
 * turn against, not just OpenRouter's own live account figures above it.
 */
export function renderLocalUsageReport(report: UsageReport): string {
  const hasAny = Object.keys(report.byProvider).length > 0;
  if (!hasAny) {
    return mutedColor('No usage recorded yet.');
  }

  const lines: string[] = [mutedColor('All providers — recorded locally')];
  lines.push(totalsRow('Today', report.today));
  lines.push(totalsRow('This week', report.week) + mutedColor('   (from Monday)'));
  lines.push(totalsRow('This month', report.month));

  lines.push('');
  lines.push(mutedColor('By provider, all time'));
  for (const [provider, totals] of Object.entries(report.byProvider)) {
    lines.push(totalsRow(provider, totals));
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/usage/render-usage.test.ts`
Expected: PASS (all existing tests plus the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/usage/render-usage.ts tests/usage/render-usage.test.ts
git commit -m "feat: render the local, cross-provider usage report"
```

---

### Task 5: Record every turn from `runTurn`

**Files:**
- Modify: `src/repl/run-turn.ts`
- Test: `tests/repl/run-turn-usage.test.ts`

**Interfaces:**
- Consumes: `UsageLog`, `UsageEntry` from `src/usage/usage-log.js` (Task 2);
  `estimateCost` from `src/usage/pricing.js` (Task 1).
- Produces: `TurnOptions.usageLog?: UsageLog` (new optional field) — no other
  task consumes this directly; it's exercised end-to-end via the gateway and
  REPL, which get it for free by not passing an override.

- [ ] **Step 1: Write the failing test**

Append to `tests/repl/run-turn-usage.test.ts`:

```typescript
import { UsageLog } from '../../src/usage/usage-log';

describe('runTurn and the usage log', () => {
  it('appends one entry per successful turn, with an estimated cost', async () => {
    const p = provider(
      [[{ type: 'text', text: 'hi' }, usage(1_000_000, 1_000_000)]],
      'anthropic',
      'Claude'
    );
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(createSession(p, 'claude-sonnet-5'), 'hello', options({ usageLog: log }));
    await log.flush();

    const entries = await log.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(entries[0].estimatedCostUsd).toBeCloseTo(18, 5); // $3 + $15 per million
  });

  it('records a null estimated cost for a provider with no pricing entry', async () => {
    const p = provider([[{ type: 'text', text: 'hi' }, usage(100, 10)]], 'ollama', 'Ollama (local)');
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(createSession(p, 'llama3'), 'hello', options({ usageLog: log }));
    await log.flush();

    expect((await log.readAll())[0].estimatedCostUsd).toBeNull();
  });

  it('records nothing when the provider reported no usage', async () => {
    const p = provider([[{ type: 'text', text: 'hi' }]]);
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(createSession(p, 'm1'), 'hello', options({ usageLog: log }));
    await log.flush();

    expect(await log.readAll()).toEqual([]);
  });

  it('records nothing for a turn that ultimately fails', async () => {
    const failing = provider([[]], 'copilot', 'GitHub Copilot');
    failing.chat = vi.fn().mockImplementation(async function* () {
      throw new Error('boom');
    }) as never;
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(
      createSession(failing, 'm1'),
      'hello',
      options({ usageLog: log, fallback: false })
    );
    await log.flush();

    expect(await log.readAll()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repl/run-turn-usage.test.ts`
Expected: FAIL — `options({ usageLog: log })` is accepted (options is untyped
`as never`) but the log stays empty, so the first two new tests fail on the
`toHaveLength(1)` / cost assertions.

- [ ] **Step 3: Write the implementation**

In `src/repl/run-turn.ts`, add the import and the new option:

```typescript
import { UsageLog } from '../usage/usage-log.js';
import { estimateCost } from '../usage/pricing.js';
```

Add to `TurnOptions` (after `providers?: Provider[];`):

```typescript
  /** Where completed turns are recorded. Defaults to the real per-profile log. */
  usageLog?: UsageLog;
```

Inside `runTurn`, alongside the existing `contextLimits` default (near line
129):

```typescript
  const usageLog = options.usageLog ?? new UsageLog();
```

At the success return point (replacing the existing `return { ok: true, ... }`
block, around line 206):

```typescript
      session.history.push(...newMessages);
      if (usage) {
        void usageLog.append({
          ts: new Date().toISOString(),
          provider: activeProvider.id,
          model: activeModel,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostUsd: estimateCost(activeProvider.id, activeModel, usage),
        });
      }
      // An abort returns normally from runAgentTurn, so the catch below — and
      // with it the fallback chain — is unreachable for it by construction.
      return {
        ok: true,
        provider: activeProvider,
        model: activeModel,
        usage,
        aborted: options.signal?.aborted ?? false,
      };
```

No change needed at the failure return (`return { ok: false, ... }` at the
end) — a failed turn's `usage` is already reset to `undefined` in the catch
block (line 217) before any retry, so nothing is recorded for it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repl/run-turn-usage.test.ts`
Expected: PASS (all existing tests plus the 4 new ones)

Then run the full suite once to confirm nothing else regressed:

Run: `npx vitest run tests/repl/run-turn.test.ts tests/repl/run-turn-usage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repl/run-turn.ts tests/repl/run-turn-usage.test.ts
git commit -m "feat: record every completed turn's usage and estimated cost"
```

---

### Task 6: Extend `/usage` in the REPL

**Files:**
- Modify: `src/repl/repl-context.ts`
- Modify: `src/repl/run-repl.ts`
- Modify: `src/repl/commands/info.ts`
- Test: `tests/repl/commands/info.test.ts` (create if it does not already exist — check first)

**Interfaces:**
- Consumes: `UsageLog` (Task 2), `buildUsageReport` (Task 3),
  `renderLocalUsageReport` (Task 4).

- [ ] **Step 1: Check for an existing test file**

Run: `find tests/repl/commands -iname "info.test.ts"` (or, on Windows,
`Get-ChildItem tests/repl/commands -Filter info.test.ts`)

If it exists, read it first and match its existing mocking style for
`ReplContext`. If it does not exist, write the test file from scratch as
below.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/repl/commands/info.test.ts (new sections, or new file)
import { describe, it, expect, vi } from 'vitest';
import { handleUsage } from '../../../src/repl/commands/info';
import type { ReplContext } from '../../../src/repl/repl-context';
import type { UsageEntry } from '../../../src/usage/usage-log';

function ctxWith(entries: UsageEntry[], openRouterUsage: unknown = null): ReplContext {
  return {
    stores: {
      usage: { get: vi.fn().mockResolvedValue(openRouterUsage) },
      usageLog: { readAll: vi.fn().mockResolvedValue(entries) },
    },
  } as unknown as ReplContext;
}

describe('handleUsage', () => {
  it('prints the local report even when OpenRouter usage is unavailable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const entry: UsageEntry = {
      ts: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.0006,
    };

    await handleUsage(ctxWith([entry]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('anthropic');
    logSpy.mockRestore();
  });

  it('says nothing has been recorded yet on a fresh profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleUsage(ctxWith([]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('No usage recorded yet');
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/repl/commands/info.test.ts`
Expected: FAIL — `ctx.stores.usageLog` does not exist on `ReplContext` /
`handleUsage` doesn't read it, so the local-report assertions fail.

- [ ] **Step 4: Write the implementation**

In `src/repl/repl-context.ts`, add the import and field:

```typescript
import type { UsageLog } from '../usage/usage-log.js';
```

Add `usageLog: UsageLog;` to the `stores` block (after `usage: UsageCache;`).

In `src/repl/run-repl.ts`, add the import, instantiate it alongside
`usageCache`, and add it to the `stores` object literal:

```typescript
import { UsageLog } from '../usage/usage-log.js';
```

```typescript
  const usageCache = new UsageCache();
  const usageLog = new UsageLog();
```

```typescript
      usage: usageCache,
      usageLog,
```

In `src/repl/commands/info.ts`, update the import and `handleUsage`:

```typescript
import { renderUsageReport, renderLocalUsageReport } from '../../usage/render-usage.js';
import { buildUsageReport } from '../../usage/usage-report.js';
```

```typescript
export async function handleUsage(ctx: ReplContext): Promise<void> {
  const usage = await ctx.stores.usage.get();
  console.log(
    usage
      ? renderUsageReport(usage)
      : mutedColor(
          'No OpenRouter usage available — run `robin login openrouter`, or check your connection.'
        )
  );
  console.log();
  const entries = await ctx.stores.usageLog.readAll();
  console.log(renderLocalUsageReport(buildUsageReport(entries)));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/repl/commands/info.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — in particular, anything constructing a `ReplContext` object
literal directly (rather than through `ctxWith`-style partial mocks) needs a
`usageLog` field too; fix any such test fixture now.

- [ ] **Step 7: Commit**

```bash
git add src/repl/repl-context.ts src/repl/run-repl.ts src/repl/commands/info.ts tests/repl/commands/info.test.ts
git commit -m "feat: show all-provider usage and cost in /usage"
```

---

### Task 7: `robin usage` CLI command

**Files:**
- Create: `src/commands/usage-command.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/usage-command.test.ts`

**Interfaces:**
- Consumes: `UsageLog` (Task 2), `buildUsageReport` (Task 3),
  `renderLocalUsageReport` (Task 4).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/commands/usage-command.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runUsage } from '../../src/commands/usage-command';
import type { UsageLog, UsageEntry } from '../../src/usage/usage-log';

function fakeLog(entries: UsageEntry[]): UsageLog {
  return { readAll: vi.fn().mockResolvedValue(entries) } as unknown as UsageLog;
}

describe('runUsage', () => {
  it('prints the local usage report', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const entry: UsageEntry = {
      ts: new Date().toISOString(),
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputTokens: 200,
      outputTokens: 40,
      estimatedCostUsd: 0.0002,
    };

    await runUsage(fakeLog([entry]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('gemini');
    logSpy.mockRestore();
  });

  it('says so plainly when nothing has been recorded', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUsage(fakeLog([]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('No usage recorded yet');
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/usage-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/usage-command'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/commands/usage-command.ts
import { UsageLog } from '../usage/usage-log.js';
import { buildUsageReport } from '../usage/usage-report.js';
import { renderLocalUsageReport } from '../usage/render-usage.js';

export async function runUsage(log: UsageLog = new UsageLog()): Promise<void> {
  const entries = await log.readAll();
  console.log(renderLocalUsageReport(buildUsageReport(entries)));
}
```

In `src/cli.ts`, add the import near the other command imports:

```typescript
import { runUsage } from './commands/usage-command.js';
```

Register the command next to `status` (after the `program.command('status')...` block):

```typescript
program
  .command('usage')
  .description('Show token usage and estimated cost across every provider')
  .action(async () => {
    await runUsage();
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commands/usage-command.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Manually verify the CLI command**

Run: `npm run build && node dist/cli.js usage`
Expected: Prints `No usage recorded yet.` on a fresh profile, or a report if
`~/.robin/usage/usage.jsonl` already has entries from earlier manual testing
of Task 5/6.

- [ ] **Step 7: Commit**

```bash
git add src/commands/usage-command.ts src/cli.ts tests/commands/usage-command.test.ts
git commit -m "feat: add \`robin usage\` for cost reporting outside a chat session"
```

---

## Post-plan manual check

After Task 7, start a real session (`robin chat`) against a couple of
different providers, send a message to each, then run `/usage` in the REPL
and `robin usage` from another terminal. Confirm:
- Tokens and estimated cost appear for providers with a pricing entry
  (Anthropic, Gemini).
- Copilot/Ollama/local rows show tokens with no dollar figure.
- The OpenRouter section above the local report is unchanged from before
  this feature.
