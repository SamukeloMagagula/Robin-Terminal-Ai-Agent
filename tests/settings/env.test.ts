import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { capturePristineEnv, pristineEnv } from '../../src/settings/env';
import { SettingsStore } from '../../src/settings/store';
import { hydrateEnv } from '../../src/settings/hydrate';

describe('the pristine environment', () => {
  it('keeps the values it captured when the live environment changes afterwards', () => {
    const live: NodeJS.ProcessEnv = { ROBIN_DEBUG: '1' };
    capturePristineEnv(live);
    live.ROBIN_GATEWAY_PORT = '9999';
    expect(pristineEnv().ROBIN_DEBUG).toBe('1');
    expect(pristineEnv().ROBIN_GATEWAY_PORT).toBeUndefined();
  });
});

describe('hydration and source reporting together', () => {
  it('does not let a hydrated value be reported as coming from the environment', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-env-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ 'gateway.port': 7777 }), 'utf-8');

    // What the CLI does at startup: snapshot the environment, then publish
    // stored settings into the live one.
    const live: NodeJS.ProcessEnv = {};
    capturePristineEnv(live);
    const store = new SettingsStore(file, pristineEnv(), () => {});
    await hydrateEnv(store, live);

    expect(live.ROBIN_GATEWAY_PORT).toBe('7777');

    const resolved = await store.resolve('gateway.port');
    expect(resolved.value).toBe(7777);
    expect(resolved.source).toBe('file');
    expect(resolved.shadowed).toBeUndefined();
  });

  it('still reports a genuinely exported variable as coming from the environment', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-env-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ 'gateway.port': 7777 }), 'utf-8');

    const live: NodeJS.ProcessEnv = { ROBIN_GATEWAY_PORT: '8080' };
    capturePristineEnv(live);
    const store = new SettingsStore(file, pristineEnv(), () => {});
    await hydrateEnv(store, live);

    const resolved = await store.resolve('gateway.port');
    expect(resolved.value).toBe(8080);
    expect(resolved.source).toBe('env');
    expect(resolved.shadowed).toBe(7777);
  });
});
