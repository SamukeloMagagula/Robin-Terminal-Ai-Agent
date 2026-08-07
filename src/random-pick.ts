import type { Provider } from './providers/types.js';

export interface RandomChoice {
  provider: Provider;
  model: string;
}

/**
 * Uniform index into an array of `length`. The clamp matters: an `rng`
 * returning exactly 1 would otherwise produce an out-of-range index.
 */
function randomIndex(length: number, rng: () => number): number {
  return Math.min(Math.floor(rng() * length), length - 1);
}

/** A rejected isAuthenticated() counts as "not usable", the same way `robin status` treats it. */
async function isUsable(provider: Provider): Promise<boolean> {
  try {
    return await provider.isAuthenticated();
  } catch {
    return false;
  }
}

/**
 * Picks a random provider, then a random model from it.
 *
 * Deliberately two-stage rather than uniform across the union of all models:
 * OpenRouter lists 300+ models against Copilot's 2, so a flat pick would return
 * OpenRouter about 85% of the time. Choosing the provider first gives every
 * provider an equal turn regardless of catalogue size.
 *
 * `rng` exists as a testable seam; production never passes it.
 */
export async function pickRandomProviderAndModel(
  providers: Provider[],
  rng: () => number = Math.random
): Promise<RandomChoice> {
  const usable: Provider[] = [];
  for (const provider of providers) {
    if (await isUsable(provider)) usable.push(provider);
  }

  if (usable.length === 0) {
    throw new Error(
      'No providers are logged in. Run `robin login <provider>` first, or pick one manually.'
    );
  }

  const candidates = [...usable];
  const failures: string[] = [];

  while (candidates.length > 0) {
    const index = randomIndex(candidates.length, rng);
    const provider = candidates[index];
    candidates.splice(index, 1);

    let models: string[];
    try {
      models = await provider.listModels();
    } catch (err) {
      failures.push(`${provider.name}: ${(err as Error).message}`);
      continue;
    }

    if (models.length === 0) {
      failures.push(`${provider.name}: no models available`);
      continue;
    }

    return { provider, model: models[randomIndex(models.length, rng)] };
  }

  throw new Error(`Could not pick a random model — every provider failed:\n  ${failures.join('\n  ')}`);
}
