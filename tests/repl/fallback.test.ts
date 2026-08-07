import { describe, it, expect, vi } from 'vitest';
import {
  buildFallbackCandidates,
  MAX_FALLBACK_CANDIDATES,
  MAX_SAME_PROVIDER_CANDIDATES,
} from '../../src/repl/fallback';
import type { Provider } from '../../src/providers/types';

function fakeProvider(overrides: Partial<Provider> & { id: string; name: string }): Provider {
  return {
    isAuthenticated: vi.fn().mockResolvedValue(false),
    login: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    chat: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  } as Provider;
}

describe('buildFallbackCandidates', () => {
  it('lists other models on the current provider first', async () => {
    const current = fakeProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4o-mini']),
    });

    const candidates = await buildFallbackCandidates(current, 'gpt-4o', [current]);

    expect(candidates).toEqual([{ provider: current, model: 'gpt-4o-mini' }]);
  });

  it('excludes the current (provider, model) pair', async () => {
    const current = fakeProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: vi.fn().mockResolvedValue(['gpt-4o']),
    });

    const candidates = await buildFallbackCandidates(current, 'gpt-4o', [current]);

    expect(candidates).toEqual([]);
  });

  it('falls back to other authenticated providers after the current one', async () => {
    const current = fakeProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: vi.fn().mockResolvedValue(['gpt-4o']),
    });
    const other = fakeProvider({
      id: 'ollama',
      name: 'Ollama (local)',
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue(['llama3.1:latest']),
    });

    const candidates = await buildFallbackCandidates(current, 'gpt-4o', [current, other]);

    expect(candidates).toEqual([{ provider: other, model: 'llama3.1:latest' }]);
  });

  it('skips providers that are not authenticated', async () => {
    const current = fakeProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: vi.fn().mockResolvedValue([]),
    });
    const other = fakeProvider({
      id: 'ollama',
      name: 'Ollama (local)',
      isAuthenticated: vi.fn().mockResolvedValue(false),
      listModels: vi.fn().mockResolvedValue(['llama3.1:latest']),
    });

    const candidates = await buildFallbackCandidates(current, 'gpt-4o', [current, other]);

    expect(candidates).toEqual([]);
  });

  it('treats a listModels() failure as no models rather than throwing', async () => {
    const current = fakeProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: vi.fn().mockRejectedValue(new Error('unreachable')),
    });

    await expect(buildFallbackCandidates(current, 'gpt-4o', [current])).resolves.toEqual([]);
  });

  it('treats an isAuthenticated() failure as unauthenticated rather than throwing', async () => {
    const current = fakeProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: vi.fn().mockResolvedValue([]),
    });
    const other = fakeProvider({
      id: 'ollama',
      name: 'Ollama (local)',
      isAuthenticated: vi.fn().mockRejectedValue(new Error('down')),
    });

    await expect(buildFallbackCandidates(current, 'gpt-4o', [current, other])).resolves.toEqual([]);
  });

  // Reproduces a real failure: the chain retried onto a text-to-speech model,
  // which answered a text request with a 400.
  it('excludes models that cannot serve a chat request', async () => {
    const current = fakeProvider({
      id: 'gemini',
      name: 'Gemini',
      listModels: vi
        .fn()
        .mockResolvedValue([
          'gemini-2.5-flash',
          'gemini-2.5-pro',
          'gemini-2.5-flash-preview-tts',
          'gemini-2.5-pro-preview-tts',
          'text-embedding-004',
          'imagen-3.0-generate-002',
        ]),
    });

    const candidates = await buildFallbackCandidates(current, 'gemini-2.5-flash', [current]);
    expect(candidates.map((c) => c.model)).toEqual(['gemini-2.5-pro']);
  });

  it('caps how many models on the current provider one failed turn retries', async () => {
    const current = fakeProvider({
      id: 'gemini',
      name: 'Gemini',
      listModels: vi
        .fn()
        .mockResolvedValue(Array.from({ length: 40 }, (_, i) => `model-${i}`)),
    });

    const candidates = await buildFallbackCandidates(current, 'model-0', [current]);
    expect(candidates).toHaveLength(MAX_SAME_PROVIDER_CANDIDATES);
    expect(candidates[0].model).toBe('model-1');
  });

  // Without a reservation, a 300-model current provider fills every slot — so a
  // rate limit, which refuses every model on that account, leaves nothing to
  // fall back to even though another provider is logged in and working.
  it('reserves slots for other providers when the current one has a huge catalogue', async () => {
    const current = fakeProvider({
      id: 'openrouter',
      name: 'OpenRouter',
      listModels: vi.fn().mockResolvedValue(Array.from({ length: 300 }, (_, i) => `or-${i}`)),
    });
    const other = fakeProvider({
      id: 'ollama',
      name: 'Ollama',
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue(['llama3.1']),
    });

    const candidates = await buildFallbackCandidates(current, 'or-0', [current, other]);
    expect(candidates.filter((c) => c.provider.id === 'openrouter')).toHaveLength(
      MAX_SAME_PROVIDER_CANDIDATES
    );
    expect(candidates.some((c) => c.provider.id === 'ollama')).toBe(true);
  });

  it('round-robins the other providers rather than draining one', async () => {
    const current = fakeProvider({ id: 'gemini', name: 'Gemini' });
    const a = fakeProvider({
      id: 'a',
      name: 'A',
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue(['a1', 'a2', 'a3', 'a4']),
    });
    const b = fakeProvider({
      id: 'b',
      name: 'B',
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue(['b1', 'b2']),
    });

    const candidates = await buildFallbackCandidates(current, 'x', [current, a, b]);
    expect(candidates.map((c) => c.model)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('counts the cap across providers, not per provider', async () => {
    const current = fakeProvider({
      id: 'gemini',
      name: 'Gemini',
      listModels: vi.fn().mockResolvedValue(['a', 'b', 'c', 'd']),
    });
    const other = fakeProvider({
      id: 'openrouter',
      name: 'OpenRouter',
      isAuthenticated: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue(['x', 'y', 'z']),
    });

    const candidates = await buildFallbackCandidates(current, 'a', [current, other]);
    expect(candidates).toHaveLength(MAX_FALLBACK_CANDIDATES);
    expect(candidates.map((c) => c.model)).toEqual(['b', 'c', 'd', 'x', 'y']);
  });
});
