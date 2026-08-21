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
