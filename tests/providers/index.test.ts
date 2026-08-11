import { describe, it, expect } from 'vitest';
import { listProviders, getProvider } from '../../src/providers/index';

describe('provider registry', () => {
  it('lists copilot, ollama, gemini, openrouter, and anthropic', () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toEqual(['copilot', 'ollama', 'gemini', 'openrouter', 'anthropic']);
  });

  it('getProvider returns the matching provider', () => {
    expect(getProvider('ollama').name).toBe('Ollama (local)');
  });

  it('getProvider throws for unknown id', () => {
    expect(() => getProvider('nope')).toThrow(/Unknown provider/);
  });
});
