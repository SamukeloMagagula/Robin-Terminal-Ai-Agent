import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SettingsStore } from '../../src/settings/store';
import { storedChatDefault } from '../../src/settings/defaults';
import type { Provider } from '../../src/providers/types';

function provider(id: string): Provider {
  return { id, name: id } as unknown as Provider;
}

const PROVIDERS = [provider('ollama'), provider('anthropic')];

async function store(): Promise<SettingsStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-defaults-'));
  return new SettingsStore(path.join(dir, 'settings.json'), {}, () => {});
}

describe('storedChatDefault', () => {
  it('returns the stored pair when both halves are set and the provider exists', async () => {
    const s = await store();
    await s.set('default.provider', 'ollama');
    await s.set('default.model', 'llama3.1');
    expect(await storedChatDefault(s, PROVIDERS)).toEqual({
      provider: PROVIDERS[0],
      model: 'llama3.1',
    });
  });

  it('returns nothing when neither half is set', async () => {
    expect(await storedChatDefault(await store(), PROVIDERS)).toBeNull();
  });

  it('returns nothing when only the provider is set, since a model is still needed', async () => {
    const s = await store();
    await s.set('default.provider', 'ollama');
    expect(await storedChatDefault(s, PROVIDERS)).toBeNull();
  });

  it('returns nothing when only the model is set', async () => {
    const s = await store();
    await s.set('default.model', 'llama3.1');
    expect(await storedChatDefault(s, PROVIDERS)).toBeNull();
  });

  it('falls back to the menu, with a warning, when the stored provider no longer exists', async () => {
    const s = await store();
    await s.set('default.provider', 'ollama');
    await s.set('default.model', 'llama3.1');
    const warn = vi.fn();
    expect(await storedChatDefault(s, [provider('anthropic')], warn)).toBeNull();
    expect(warn.mock.calls.join(' ')).toContain('ollama');
  });
});
