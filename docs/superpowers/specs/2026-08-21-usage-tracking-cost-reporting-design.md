# Usage tracking and cost reporting

## Problem

Robin already measures token usage per API round — `TokenUsage` in
`src/providers/types.ts`, emitted as a `usage` `ChatEvent` by every provider
that reports it — and sums it per turn in `runTurn`
(`src/repl/run-turn.ts`). But that sum only ever reaches
`session-service.ts`, which adds it to an in-memory `record.tokens` that is
gone the moment the session closes. Nothing persists across restarts, nothing
rolls up across sessions or days, and nothing is priced into a dollar figure
except OpenRouter, whose `/usage` report (`src/usage/openrouter-usage.ts`,
`src/usage/render-usage.ts`) calls OpenRouter's own account API for live
billed spend. Anthropic, Gemini, Copilot, Ollama, and local backends have no
usage or cost visibility at all.

This spec adds a persistent, cross-provider, cross-session usage log with
estimated cost, and two ways to read it: the existing `/usage` REPL command,
and a new `robin usage` CLI subcommand.

## Non-goals

- Real-time spend caps or budget alerts. This is reporting, not enforcement.
- Per-tool-call or per-message granularity. One entry per turn is enough to
  answer "what did today cost."
- Billing-accurate costs for providers that don't expose per-token pricing
  (Copilot's flat subscription) or that run locally (Ollama, local). Those
  rows show tokens with no dollar figure, never a fabricated one.
- Log rotation or compaction. Same tradeoff `AuditLog` already makes — kept
  simple until it's a real problem.

## Recording: `src/usage/usage-log.ts`

A new `UsageLog` class, modeled directly on `src/autonomy/audit.ts`'s
`AuditLog`:

```typescript
export interface UsageEntry {
  ts: string; // ISO 8601
  provider: string; // Provider.id
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** null when this provider/model has no per-token price (Copilot, Ollama, local). */
  estimatedCostUsd: number | null;
}

export class UsageLog {
  constructor(private readonly file: string = defaultUsageLogPath()) {}
  async append(entry: UsageEntry): Promise<Error | undefined>;
  async readAll(): Promise<UsageEntry[]>;
}
```

- Path: `<profile-home>/usage/usage.jsonl` via `robinHome()` from
  `src/profile.ts` — one file per profile, consistent with how every other
  store (auth, chats, audit) is already profile-scoped.
- Appends are chained on an internal `Promise` queue exactly like
  `AuditLog.append`, so concurrent turns can't interleave partial JSON lines,
  and a write failure is returned to the caller rather than thrown or
  swallowed.
- `readAll()` parses line by line and skips a line that fails to parse (a
  truncated final line from an interrupted write must not lose the rest —
  same rule `AuditLog.read` already follows).
- Directory created with `{ recursive: true, mode: 0o700 }`, file written with
  `mode: 0o600`, matching the audit log's handling of what is, in effect,
  another local activity record.

## Recording point: `runTurn`

`runTurn` (`src/repl/run-turn.ts`) already accumulates `usage: TokenUsage`
across every round of a turn (`addUsage`, lines 143–149) and knows the final
`activeProvider` and `activeModel` once fallback has settled. A `UsageLog` is
added as an optional dependency on `TurnOptions` (default: the real
`defaultUsageLogPath()`-backed instance, injectable in tests exactly like
`unsupportedStore` and `contextLimits` already are). After a turn finishes
successfully with non-empty usage, `runTurn` computes `estimatedCostUsd` via
the pricing table (below) and appends one entry, fire-and-forget — a failed
append must never fail or delay the turn it's recording, so the returned
error is logged, not thrown, matching `AuditLog`'s own contract at the call
site.

Recording inside `runTurn` rather than in `session-service.ts` means both
call sites — gateway REPL turns and `workflow/run-workflow.ts`'s per-role
turns — are captured by one code path, instead of usage tracking silently
missing every workflow run.

`session-service.ts`'s existing `record.tokens` accumulator
(`session-service.ts:384-386`) is untouched — it still drives the live
per-session tally shown during a conversation. The new log is the durable,
cross-session record behind it.

## Pricing: `src/usage/pricing.ts`

```typescript
export interface ModelPrice {
  /** Matches a model id by exact string or prefix (e.g. "claude-opus-5"). */
  match: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export const PRICING: Record<string, ModelPrice[]> = {
  anthropic: [ /* published per-model $/M token rates */ ],
  gemini: [ /* published per-model $/M token rates */ ],
  // copilot, ollama, local: absent — estimateCost() returns null for these.
};

export function estimateCost(
  providerId: string,
  model: string,
  usage: TokenUsage
): number | null;
```

- `estimateCost` looks up `PRICING[providerId]`, finds the first entry whose
  `match` is an exact match or a prefix of `model`, and returns
  `(inputTokens / 1e6) * inputPerMillion + (outputTokens / 1e6) * outputPerMillion`.
  No match, or no table for that provider at all → `null`.
- OpenRouter is deliberately absent from `PRICING` — it already gets a real,
  live billed number from `fetchOpenRouterUsage`, and estimating on top of
  that would be a second, worse answer to a question already answered
  correctly.
- The table is a static, hand-maintained snapshot of published pricing (it
  will drift as providers change prices — the same tradeoff every hardcoded
  price table makes, called out in a comment on the table itself). Keeping it
  isolated in one file makes it a one-file update when prices change.

## Reporting: `src/usage/usage-report.ts`

```typescript
export interface UsageReport {
  today: UsageTotals;
  week: UsageTotals; // UTC week, Monday start — same convention as OpenRouter's usage_weekly
  month: UsageTotals; // UTC month
  byProvider: Record<string, UsageTotals>; // all-time, per provider
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number; // sum of known costs; entries with null cost excluded
  turns: number;
}

export function buildUsageReport(entries: UsageEntry[], now: Date = new Date()): UsageReport;
```

Pure function over `UsageLog.readAll()`'s output — easy to unit test without
touching disk, following the same shape as `render-usage.ts`'s split between
data (`OpenRouterUsage`) and rendering.

A new `renderLocalUsageReport(report: UsageReport): string` in
`render-usage.ts` formats this the same way `renderUsageReport` formats the
OpenRouter one — reusing `formatUsd`, `row`, and the muted/bright color
conventions already in that file.

## Surfaces

**`/usage` (REPL).** `handleUsage` in `src/repl/commands/info.ts` keeps
printing the existing OpenRouter section unchanged, then appends the local
report: `UsageLog.readAll()` → `buildUsageReport` →
`renderLocalUsageReport`, under a header separating it from the OpenRouter
section. If the log is empty (fresh profile, nothing recorded yet), that
section prints a muted "No usage recorded yet" line instead of an empty
table.

**`robin usage` (CLI).** New `src/commands/usage-command.ts`, registered in
`cli.ts` next to `status-command.ts`. Reads the same `UsageLog` for the
active profile and prints the same local report — usable without opening a
chat session at all, e.g. to check spend from a script or before deciding
whether to kick off a long-running job. No flags in this first pass (no
`--json`, no `--days N`) — YAGNI until a real need for machine-readable or
custom-range output shows up.

## Testing

- `usage-log.test.ts`: append/readAll round-trip, concurrent appends land in
  order, a corrupt trailing line doesn't lose prior entries — mirrors
  `audit.test.ts`'s existing coverage of `AuditLog`.
- `pricing.test.ts`: exact match, prefix match, no match → `null`, and that
  `copilot`/`ollama`/`local` always return `null`.
- `usage-report.test.ts`: day/week/month bucketing at UTC boundaries
  (including the Monday-week-start edge already exercised for OpenRouter),
  entries with `estimatedCostUsd: null` counted in tokens but excluded from
  the cost sum.
- `run-turn.test.ts`: extend existing coverage to assert a successful turn
  with usage appends exactly one `UsageEntry` via an injected fake
  `UsageLog`, and that a failed append doesn't fail the turn.
