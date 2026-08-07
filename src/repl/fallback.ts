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
    if (model !== currentModel && isChatCapableModel(model)) {
      candidates.push({ provider: currentProvider, model });
    }
  }

  for (const provider of allProviders) {
    if (provider.id === currentProvider.id) continue;
    if (!(await safeIsAuthenticated(provider))) continue;
    for (const model of await usable(provider)) {
      if (isChatCapableModel(model)) candidates.push({ provider, model });
    }
  }

  return candidates.slice(0, MAX_FALLBACK_CANDIDATES);
}
