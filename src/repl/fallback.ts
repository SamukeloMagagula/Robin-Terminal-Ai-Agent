import type { Provider } from '../providers/types.js';
import { isChatCapableModel } from './model-capability.js';

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
  allProviders: Provider[]
): Promise<FallbackCandidate[]> {
  const candidates: FallbackCandidate[] = [];

  const sameProviderModels = await safeListModels(currentProvider);
  for (const model of sameProviderModels) {
    if (model !== currentModel && isChatCapableModel(model)) {
      candidates.push({ provider: currentProvider, model });
    }
  }

  for (const provider of allProviders) {
    if (provider.id === currentProvider.id) continue;
    if (!(await safeIsAuthenticated(provider))) continue;
    const models = await safeListModels(provider);
    for (const model of models) {
      if (isChatCapableModel(model)) candidates.push({ provider, model });
    }
  }

  return candidates.slice(0, MAX_FALLBACK_CANDIDATES);
}
