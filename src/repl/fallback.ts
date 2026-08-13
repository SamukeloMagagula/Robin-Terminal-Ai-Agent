import type { Provider } from '../providers/types.js';
import { isChatCapableModel } from './model-capability.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';

export interface FallbackCandidate {
  provider: Provider;
  model: string;
}

/**
 * Cap on how many models a single failed turn will retry against.
 *
 * Without one, a rate-limited provider makes the loop walk its entire
 * catalogue — a user watched eight consecutive failures scroll past before a
 * model answered. Each attempt is a real API round-trip, so the wait is worse
 * than the failure. If a handful of models in a row all refuse, the problem is
 * the account or the network, not the model.
 */
export const MAX_FALLBACK_CANDIDATES = 5;

/**
 * How many of those slots the current provider may take.
 *
 * The rest are reserved for other providers. Without this reservation the
 * current provider fills every slot, so when it refuses for an account-wide
 * reason — a rate limit, exhausted credit — the whole chain is models that
 * will refuse identically, and a perfectly good second provider is never
 * reached.
 */
export const MAX_SAME_PROVIDER_CANDIDATES = 3;

async function safeListModels(provider: Provider): Promise<string[]> {
  try {
    return await provider.listModels();
  } catch {
    return [];
  }
}

async function safeIsAuthenticated(provider: Provider): Promise<boolean> {
  try {
    return await provider.isAuthenticated();
  } catch {
    return false;
  }
}

/**
 * Ordered list of (provider, model) pairs to retry a failed turn on: remaining
 * models on the current provider first, then models on every other
 * authenticated provider. Never includes the (currentProvider, currentModel)
 * pair itself.
 */
export async function buildFallbackCandidates(
  currentProvider: Provider,
  currentModel: string,
  allProviders: Provider[],
  unsupportedStore: UnsupportedModelStore = new UnsupportedModelStore()
): Promise<FallbackCandidate[]> {
  const candidates: FallbackCandidate[] = [];

  // Models a provider has already rejected as unsupported will reject again.
  // Retrying into them is what turned one failure into five.
  const usable = async (provider: Provider): Promise<string[]> =>
    unsupportedStore.filter(provider.id, await safeListModels(provider));

  for (const model of await usable(currentProvider)) {
    if (candidates.length >= MAX_SAME_PROVIDER_CANDIDATES) break;
    if (model !== currentModel && isChatCapableModel(model)) {
      candidates.push({ provider: currentProvider, model });
    }
  }

  // Round-robin across the other providers so a single large catalogue cannot
  // consume every remaining slot.
  const otherModels: { provider: Provider; models: string[] }[] = [];
  for (const provider of allProviders) {
    if (provider.id === currentProvider.id) continue;
    if (!(await safeIsAuthenticated(provider))) continue;
    const models = (await usable(provider)).filter(isChatCapableModel);
    if (models.length > 0) otherModels.push({ provider, models });
  }  for (let round = 0; candidates.length < MAX_FALLBACK_CANDIDATES; round++) {
    const added = otherModels.filter((entry) => entry.models.length > round);
    if (added.length === 0) break;
    for (const entry of added) {
      if (candidates.length >= MAX_FALLBACK_CANDIDATES) break;
      candidates.push({ provider: entry.provider, model: entry.models[round] });
    }
  }

  return candidates;
}
