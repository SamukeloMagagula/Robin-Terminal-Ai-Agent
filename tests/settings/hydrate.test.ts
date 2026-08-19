import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SettingsStore } from '../../src/settings/store';
import { hydrateEnv } from '../../src/settings/hydrate';

async function storeWith(
  contents: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {}
): Promise<{ store: SettingsStore; env: NodeJS.ProcessEnv }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-hydrate-'));
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify(contents), 'utf-8');
  return { store: new SettingsStore(file, env, () => {}), env };
}

describe('hydrateEnv', () => {
  it('publishes a stored value into the variable the existing code reads', async () => {
    const { store, env } = await storeWith({ 'gateway.port': 7777 });
    await hydrateEnv(store, env);
    expect(env.ROBIN_GATEWAY_PORT).toBe('7777');
  });

  it('leaves a variable that is already set alone, so the environment still wins', async () => {
    const { store, env } = await storeWith({ 'gateway.port': 7777 }, { ROBIN_GATEWAY_PORT: '8080' });
    await hydrateEnv(store, env);
    expect(env.ROBIN_GATEWAY_PORT).toBe('8080');
  });

  it('sets a flag variable when the setting asks for it', async () => {
    const { store, env } = await storeWith({ debug: true });
    await hydrateEnv(store, env);
    expect(env.ROBIN_DEBUG).toBe('1');
  });

  it('leaves a flag variable unset when the setting is off', async () => {
    const { store, env } = await storeWith({ debug: false });
    await hydrateEnv(store, env);
    expect(env.ROBIN_DEBUG).toBeUndefined();
  });

  it('sets the inverted flag when history is turned off', async () => {
    const { store, env } = await storeWith({ 'history.enabled': false });
    await hydrateEnv(store, env);
    expect(env.ROBIN_NO_HISTORY_FILE).toBe('1');
  });

  it('leaves the inverted flag unset when history is on, which is the default', async () => {
    const { store, env } = await storeWith({ 'history.enabled': true });
    await hydrateEnv(store, env);
    expect(env.ROBIN_NO_HISTORY_FILE).toBeUndefined();
  });

  it('publishes nothing for a setting that has no stored value', async () => {
    const { store, env } = await storeWith({});
    await hydrateEnv(store, env);
    expect(env.ROBIN_GATEWAY_PORT).toBeUndefined();
    expect(env.ROBIN_LOCAL_BASE_URL).toBeUndefined();
  });

  it('publishes nothing for settings that no variable corresponds to', async () => {
    const { store, env } = await storeWith({ 'default.provider': 'ollama' });
    await hydrateEnv(store, env);
    expect(Object.keys(env)).toEqual([]);
  });
});
