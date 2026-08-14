import { describe, it, expect } from 'vitest';
import { listProviders, getProvider } from '../../src/providers/index';

describe('provider registry', () => {
  it('lists copilot, ollama, local, gemini, openrouter, and anthropic', () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toEqual(['copilot', 'ollama', 'local', 'gemini', 'openrouter', 'anthropic']);
  });

  it('offers a local option that is not tied to one runtime', () => {
    expect(getProvider('local').name).toBe('Local (OpenAI-compatible)');
  });

  it('getProvider returns the matching provider', () => {
    expect(getProvider('ollama').name).toBe('Ollama (local)');
  });

  it('getProvider throws for unknown id', () => {
    expect(() => getProvider('nope')).toThrow(/Unknown provider/);
  });
});
