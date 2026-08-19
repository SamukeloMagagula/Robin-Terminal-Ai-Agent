import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SettingsStore } from '../../src/settings/store';
import { orderForSetup, runSetup, type SetupDeps } from '../../src/commands/setup-command';
import type { Provider } from '../../src/providers/types';

function fakeProvider(id: string, options: { authenticated?: boolean; models?: string[] } = {}): Provider {
  return {
    id,
    name: id,
    isAuthenticated: vi.fn().mockResolvedValue(options.authenticated ?? false),
    login: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue(options.models ?? [`${id}-model`]),
    logout: vi.fn(),
    chat: vi.fn(),
  } as unknown as Provider;
}

async function deps(overrides: Partial<SetupDeps> = {}): Promise<SetupDeps & { lines: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-setup-'));
  const lines: string[] = [];
  const providers = overrides.providers ?? [fakeProvider('ollama', { models: ['llama3.1'] })];
  return {
    providers,
    store: new SettingsStore(path.join(dir, 'settings.json'), {}, () => {}),
    prompts: {
      chooseProvider: vi.fn().mockResolvedValue(providers[0]),
      chooseModel: vi.fn().mockImplementation(async (models: string[]) => models[0]),
    },
    login: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue(undefined),
    out: (line: string) => lines.push(line),
    ...overrides,
    lines,
  } as SetupDeps & { lines: string[] };
}

describe('orderForSetup', () => {
  it('puts the providers that need no account first', () => {
    const ordered = orderForSetup([
      fakeProvider('anthropic'),
      fakeProvider('local'),
      fakeProvider('copilot'),
      fakeProvider('ollama'),
    ]);
    expect(ordered.slice(0, 2).map((p) => p.id)).toEqual(['ollama', 'local']);
  });

  it('keeps the remaining providers in the order given', () => {
    const ordered = orderForSetup([fakeProvider('anthropic'), fakeProvider('copilot'), fakeProvider('ollama')]);
    expect(ordered.map((p) => p.id)).toEqual(['ollama', 'anthropic', 'copilot']);
  });
});

describe('robin setup', () => {
  it('stores the chosen provider and model', async () => {
    const d = await deps();
    await runSetup(d);
    expect(await d.store.get('default.provider')).toBe('ollama');
    expect(await d.store.get('default.model')).toBe('llama3.1');
  });

  it('logs in when the provider is not yet authenticated', async () => {
    const d = await deps({ providers: [fakeProvider('anthropic', { authenticated: false })] });
    await runSetup(d);
    expect(d.login).toHaveBeenCalled();
  });

  it('skips the login step when the provider is already authenticated', async () => {
    const d = await deps({ providers: [fakeProvider('anthropic', { authenticated: true })] });
    await runSetup(d);
    expect(d.login).not.toHaveBeenCalled();
  });

  it('verifies the choice with a real turn before storing anything', async () => {
    const d = await deps();
    await runSetup(d);
    expect(d.verify).toHaveBeenCalledWith(d.providers[0], 'llama3.1');
  });

  it('writes nothing when logging in fails', async () => {
    const d = await deps({ login: vi.fn().mockRejectedValue(new Error('bad credentials')) });
    await expect(runSetup(d)).rejects.toThrow(/bad credentials/);
    expect((await d.store.resolve('default.provider')).source).toBe('default');
  });

  it('writes nothing when the verifying turn fails', async () => {
    const d = await deps({ verify: vi.fn().mockRejectedValue(new Error('model refused')) });
    await expect(runSetup(d)).rejects.toThrow(/model refused/);
    expect((await d.store.resolve('default.model')).source).toBe('default');
  });

  it('offers the settings already stored when it is run again', async () => {
    const d = await deps();
    await d.store.set('default.provider', 'ollama');
    await d.store.set('default.model', 'llama3.1');
    await runSetup(d);
    expect(d.prompts.chooseProvider).toHaveBeenCalledWith(expect.anything(), 'ollama');
    expect(d.prompts.chooseModel).toHaveBeenCalledWith(expect.anything(), 'llama3.1');
  });

  it('tells the user what to run next', async () => {
    const d = await deps();
    await runSetup(d);
    expect(d.lines.join('\n')).toContain('robin chat');
  });

  it('reports a provider that offers no models rather than storing an empty one', async () => {
    const d = await deps({ providers: [fakeProvider('ollama', { models: [] })] });
    await expect(runSetup(d)).rejects.toThrow(/no models/i);
    expect((await d.store.resolve('default.model')).source).toBe('default');
  });
});
