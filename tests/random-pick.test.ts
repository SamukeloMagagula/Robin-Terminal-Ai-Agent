import { describe, it, expect } from 'vitest';
import { pickRandomProviderAndModel } from '../src/random-pick';
import type { Provider } from '../src/providers/types';

interface FakeOptions {
  authenticated?: boolean | 'throws';
  models?: string[] | 'throws';
}

function fakeProvider(id: string, options: FakeOptions = {}): Provider {
  const { authenticated = true, models = [`${id}-a`, `${id}-b`] } = options;
  return {
    id,
    name: id.toUpperCase(),
    async isAuthenticated() {
      if (authenticated === 'throws') throw new Error('probe exploded');
      return authenticated;
    },
    async listModels() {
      if (models === 'throws') throw new Error('catalogue unavailable');
      return models;
    },
    async login() {},
    async logout() {},
    async *chat() {},
  } as unknown as Provider;
}

/** Returns the scripted values in order, then repeats the last one. */
function scriptedRng(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe('pickRandomProviderAndModel', () => {
  it('picks the provider the rng selects, and a model from that provider', async () => {
    const providers = [fakeProvider('one'), fakeProvider('two'), fakeProvider('three')];
    // First draw indexes the provider list, second indexes that provider's models.
    const choice = await pickRandomProviderAndModel(providers, scriptedRng(0.5, 0));
    expect(choice.provider.id).toBe('two');
    expect(choice.model).toBe('two-a');
  });

  it('picks the second model when the rng lands there', async () => {
    const providers = [fakeProvider('one')];
    const choice = await pickRandomProviderAndModel(providers, scriptedRng(0, 0.9));
    expect(choice.model).toBe('one-b');
  });

  it('excludes providers that are not authenticated', async () => {
    const providers = [
      fakeProvider('locked', { authenticated: false }),
      fakeProvider('open'),
    ];
    for (const draw of [0, 0.4, 0.99]) {
      const choice = await pickRandomProviderAndModel(providers, scriptedRng(draw, 0));
      expect(choice.provider.id).toBe('open');
    }
  });

  it('excludes providers whose isAuthenticated throws', async () => {
    const providers = [
      fakeProvider('broken', { authenticated: 'throws' }),
      fakeProvider('open'),
    ];
    const choice = await pickRandomProviderAndModel(providers, scriptedRng(0, 0));
    expect(choice.provider.id).toBe('open');
  });

  it('re-rolls onto a working provider when listModels throws', async () => {
    const providers = [
      fakeProvider('flaky', { models: 'throws' }),
      fakeProvider('solid'),
    ];
    const choice = await pickRandomProviderAndModel(providers, scriptedRng(0, 0, 0));
    expect(choice.provider.id).toBe('solid');
  });

  it('re-rolls when a provider reports no models', async () => {
    const providers = [fakeProvider('empty', { models: [] }), fakeProvider('solid')];
    const choice = await pickRandomProviderAndModel(providers, scriptedRng(0, 0, 0));
    expect(choice.provider.id).toBe('solid');
  });

  it('tells the user to log in when nothing is authenticated', async () => {
    const providers = [
      fakeProvider('a', { authenticated: false }),
      fakeProvider('b', { authenticated: false }),
    ];
    await expect(pickRandomProviderAndModel(providers, scriptedRng(0))).rejects.toThrow(
      'No providers are logged in'
    );
  });

  it('handles an empty provider list', async () => {
    await expect(pickRandomProviderAndModel([], scriptedRng(0))).rejects.toThrow(
      'No providers are logged in'
    );
  });

  it('names every failure when no candidate can list models', async () => {
    const providers = [
      fakeProvider('flaky', { models: 'throws' }),
      fakeProvider('empty', { models: [] }),
    ];
    await expect(pickRandomProviderAndModel(providers, scriptedRng(0))).rejects.toThrow(
      /every provider failed[\s\S]*FLAKY: catalogue unavailable[\s\S]*EMPTY: no models available/
    );
  });

  it('stays in range when the rng returns exactly 1', async () => {
    const providers = [fakeProvider('one'), fakeProvider('two')];
    const choice = await pickRandomProviderAndModel(providers, scriptedRng(1, 1));
    expect(choice.provider.id).toBe('two');
    expect(choice.model).toBe('two-b');
  });

  // The point of picking the provider before the model: a provider with two
  // models must come up as often as one with three hundred.
  it('gives a small-catalogue provider the same chance as a large one', async () => {
    const small = fakeProvider('small', { models: ['only-one', 'only-two'] });
    const huge = fakeProvider('huge', {
      models: Array.from({ length: 300 }, (_, i) => `model-${i}`),
    });

    const counts: Record<string, number> = { small: 0, huge: 0 };
    for (let i = 0; i < 1000; i++) {
      const choice = await pickRandomProviderAndModel([small, huge]);
      counts[choice.provider.id] += 1;
    }

    // A flat pick over all 302 models would give `small` under 1%.
    expect(counts.small).toBeGreaterThan(400);
    expect(counts.huge).toBeGreaterThan(400);
  });
});
