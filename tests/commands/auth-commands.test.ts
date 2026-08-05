import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Provider } from '../../src/providers/types';
import { runLogin, runLogout } from '../../src/commands/auth-commands';

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

describe('auth commands', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('runLogin calls provider.login when not authenticated', async () => {
    const provider = fakeProvider({ isAuthenticated: vi.fn().mockResolvedValue(false) });
    await runLogin(provider);
    expect(provider.login).toHaveBeenCalledOnce();
  });

  it('runLogin skips login when already authenticated', async () => {
    const provider = fakeProvider({ isAuthenticated: vi.fn().mockResolvedValue(true) });
    await runLogin(provider);
    expect(provider.login).not.toHaveBeenCalled();
  });

  it('runLogout calls provider.logout', async () => {
    const provider = fakeProvider();
    await runLogout(provider);
    expect(provider.logout).toHaveBeenCalledOnce();
  });
});
