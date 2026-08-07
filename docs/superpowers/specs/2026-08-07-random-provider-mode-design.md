# Random provider/model mode

Date: 2026-08-07

## Goal

Let the user hand model selection over to chance: pick a random provider and a
random model from it, instead of choosing both from menus.

## Why provider-first, not uniform-over-models

Catalogue sizes are wildly uneven — OpenRouter lists 300+ models, Gemini ~40,
Copilot 2 (hardcoded), Ollama however many are pulled locally. Picking
uniformly across the union of all models would select OpenRouter roughly 85% of
the time, which is not "a random AI" so much as "a random OpenRouter model".

Selection is therefore two-stage and uniform at each stage: pick a provider,
then pick a model within it. Every provider gets an equal turn regardless of
how many models it exposes.

## Selection

New module `src/random-pick.ts`. Pure selection logic — it talks to providers
through the `Provider` interface and does no console I/O, so it is testable
with fakes.

```ts
export interface RandomChoice {
  provider: Provider;
  model: string;
}

export async function pickRandomProviderAndModel(
  providers: Provider[],
  rng?: () => number
): Promise<RandomChoice>;
```

`rng` defaults to `Math.random` and exists as a testable seam; production never
passes it.

Algorithm:

1. **Filter to usable providers.** Keep those whose `isAuthenticated()`
   resolves `true`. A rejected promise counts as `false`, matching how
   `runStatus` already treats it. This also covers Ollama's reachability, since
   its `isAuthenticated()` is an HTTP probe of `/api/tags` rather than a
   credential check — one filter handles both cases.
2. **Pick a provider uniformly** from the survivors.
3. **List its models** and pick one uniformly.
4. **On failure, re-roll.** If `listModels()` rejects or returns an empty
   array, drop that provider from the candidate pool and repeat from step 2.
   Only when every candidate has failed does the function throw.

Uniform index selection is `Math.floor(rng() * length)`, clamped to
`length - 1` so an `rng` returning exactly 1 cannot produce an out-of-range
index.

### Errors

- No authenticated providers:
  `No providers are logged in. Run \`robin login <provider>\` first, or pick one manually.`
- Every candidate failed to list models: a message naming each provider and the
  reason it was dropped, so the user can see whether it was auth, network, or
  an empty local Ollama.

## Surfaces

Three entry points, all calling the same function:

1. **Provider picker** — a `🎲 Random` choice, first in the list, in both
   `pickProvider()` and the picker reached via `pickProviderAndModel()`. Choosing
   it returns a rolled provider/model pair rather than descending into the model
   menu.
2. **`robin chat random`** — the existing `chat [provider]` argument accepts the
   literal `random`. This shadows any future provider whose id is `random`;
   acceptable, and no such provider exists.
3. **`/random`** — a new REPL slash command that re-rolls mid-session.

### `/random` semantics

Identical to the existing `/model` and `/provider` handlers: clear `history`,
call `chatLog.startNewSession()`, print the connection line. Those commands
deliberately reset history rather than carrying a conversation across a model
switch, and `/random` must not diverge from that — a re-roll is a provider
switch.

`/random` is added to `SLASH_COMMANDS` in `src/repl/slash-prompt.ts` (which
feeds both the popup and the startup banner), to `KNOWN_COMMANDS` and the
`ParsedCommand` union in `src/repl/parse-command.ts`, and to `HELP_ENTRIES` in
`run-repl.ts`.

### Announcing the roll

Every surface prints the result before use:

```
🎲 Rolled OpenRouter · anthropic/claude-3.5-sonnet
```

A random pick that does not say what it picked leaves the user unable to
interpret the reply quality or the cost.

## Interaction with the existing fallback chain

`run-repl.ts` already falls back to other provider/model candidates when a chat
request fails (the 429 → 402 → 402 sequence a user hit on free OpenRouter
models). Random selection sits upstream of that and does not change it: a roll
onto a rate-limited model is still rescued by the existing fallback, which will
then print its own connection line for whatever it landed on.

## Testing

`tests/random-pick.test.ts`, using fake `Provider` objects and a stubbed `rng`
returning a scripted sequence:

- Picks the provider the `rng` selects, and a model from that provider only.
- Excludes providers whose `isAuthenticated()` returns `false`.
- Excludes providers whose `isAuthenticated()` rejects.
- Re-rolls onto a working provider when the first choice's `listModels()`
  rejects.
- Re-rolls when `listModels()` returns an empty array.
- Throws the "no providers logged in" error when nothing is authenticated.
- Throws the exhaustion error, naming each failure, when every candidate fails.
- An `rng` returning exactly `1` still yields a valid index.
- Over a fixed scripted sequence, each provider is reachable — a provider with
  2 models is selected as often as one with 300 (the point of stage-one
  uniformity).

`tests/repl/parse-command.test.ts` gains a case for `/random`.

## Out of scope

- Re-rolling per message. Chosen against: history would be re-sent to a
  different model every turn, multiplying cost and making reply quality swing
  turn to turn.
- Weighting by model quality, price, or speed. No data source for it.
- Excluding models known to be broken or rate-limited. The existing fallback
  chain already handles a bad roll at request time.
- Persisting the rolled choice across restarts.
