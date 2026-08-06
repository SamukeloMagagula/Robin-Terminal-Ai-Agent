import type { Provider } from '../providers/types.js';

export interface FallbackCandidate {
  provider: Provider;
  model: string;
}

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
    if (model !== currentModel) candidates.push({ provider: currentProvider, model });
  }

  for (const provider of allProviders) {
    if (provider.id === currentProvider.id) continue;
    if (!(await safeIsAuthenticated(provider))) continue;
    const models = await safeListModels(provider);
    for (const model of models) {
      candidates.push({ provider, model });
    }
  }

  return candidates;
}
