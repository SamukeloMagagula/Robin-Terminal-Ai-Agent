import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Provider } from '../../src/providers/types';
import { runStatus } from '../../src/commands/status-command';

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    isAuthenticated: vi.fn().mockResolvedValue(false),
    login: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    chat: (async function* () {})(),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Provider;
}

describe('runStatus', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  it('shows "logged in" for an authenticated non-Ollama provider', async () => {
    const provider = fakeProvider({ id: 'copilot', name: 'GitHub Copilot', isAuthenticated: vi.fn().mockResolvedValue(true) });
    await runStatus([provider]);
    expect(logs.some((l) => l.includes('GitHub Copilot') && l.includes('logged in'))).toBe(true);
  });

  it('shows a "run robin login <id>" hint for a non-Ollama provider that is not authenticated', async () => {
    const provider = fakeProvider({ id: 'gemini', name: 'Gemini', isAuthenticated: vi.fn().mockResolvedValue(false) });
    await runStatus([provider]);
    expect(logs.some((l) => l.includes('robin login gemini'))).toBe(true);
  });

  it('shows "reachable" for Ollama when isAuthenticated is true', async () => {
    const provider = fakeProvider({ id: 'ollama', name: 'Ollama (local)', isAuthenticated: vi.fn().mockResolvedValue(true) });
    await runStatus([provider]);
    expect(logs.some((l) => l.includes('Ollama (local)') && l.includes('reachable') && !l.includes('not reachable'))).toBe(true);
  });

  it('shows an "ollama serve" hint for Ollama when isAuthenticated is false', async () => {
    const provider = fakeProvider({ id: 'ollama', name: 'Ollama (local)', isAuthenticated: vi.fn().mockResolvedValue(false) });
    await runStatus([provider]);
    expect(logs.some((l) => l.includes('ollama serve'))).toBe(true);
  });

  it('treats a throwing isAuthenticated as not authenticated rather than crashing', async () => {
    const provider = fakeProvider({ isAuthenticated: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(runStatus([provider])).resolves.toBeUndefined();
  });

  it('reports on every provider given', async () => {
    const a = fakeProvider({ id: 'a', name: 'Provider A' });
    const b = fakeProvider({ id: 'b', name: 'Provider B' });
    await runStatus([a, b]);
    expect(logs.some((l) => l.includes('Provider A'))).toBe(true);
    expect(logs.some((l) => l.includes('Provider B'))).toBe(true);
  });
});
