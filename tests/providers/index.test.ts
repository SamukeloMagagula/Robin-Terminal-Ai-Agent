import { describe, it, expect } from 'vitest';
import { listProviders, getProvider } from '../../src/providers/index';

describe('provider registry', () => {
  it('lists copilot and ollama', () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toEqual(['copilot', 'ollama']);
  });

  it('getProvider returns the matching provider', () => {
    expect(getProvider('ollama').name).toBe('Ollama (local)');
  });

  it('getProvider throws for unknown id', () => {
    expect(() => getProvider('nope')).toThrow(/Unknown provider/);
  });
});
