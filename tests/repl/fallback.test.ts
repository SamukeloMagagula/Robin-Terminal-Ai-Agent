import { describe, it, expect, vi } from 'vitest';
import { buildFallbackCandidates } from '../../src/repl/fallback';
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
});
