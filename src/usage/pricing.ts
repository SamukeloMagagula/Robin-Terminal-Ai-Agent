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
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion
  );
}
