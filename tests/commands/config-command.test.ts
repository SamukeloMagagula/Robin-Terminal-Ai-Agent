import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SettingsStore } from '../../src/settings/store';
import {
  describeValue,
  formatResolved,
  runConfigList,
  runConfigGet,
  runConfigSet,
  runConfigUnset,
} from '../../src/commands/config-command';

async function harness(env: NodeJS.ProcessEnv = {}): Promise<{
  store: SettingsStore;
  lines: string[];
  out: (line: string) => void;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-config-cmd-'));
  const lines: string[] = [];
  return {
    store: new SettingsStore(path.join(dir, 'settings.json'), env, () => {}),
    lines,
    out: (line) => lines.push(line),
  };
}

/** Output is compared without colour, which is styling rather than behaviour. */
function plain(lines: string[]): string {
  return lines.join('\n').replace(/\[[0-9;]*m/g, '');
}

describe('describeValue', () => {
  it('shows an unset free-text setting as unset rather than empty quotes', () => {
    expect(describeValue({ type: 'string' } as never, '')).toBe('(unset)');
  });

  it('shows booleans and numbers plainly', () => {
    expect(describeValue({ type: 'boolean' } as never, true)).toBe('true');
    expect(describeValue({ type: 'number' } as never, 18790)).toBe('18790');
  });
});

describe('formatResolved', () => {
  it('names the environment variable when it is overriding the file', async () => {
    const { store } = await harness({ ROBIN_GATEWAY_PORT: '8080' });
    await store.set('gateway.port', '7777');
    const line = formatResolved(await store.resolve('gateway.port'));
    expect(line).toContain('8080');
    expect(line).toContain('ROBIN_GATEWAY_PORT');
    expect(line).toContain('7777');
  });

  it('names the environment variable even when nothing is being overridden', async () => {
    const { store } = await harness({ ROBIN_DEBUG: '1' });
    expect(formatResolved(await store.resolve('debug'))).toContain('ROBIN_DEBUG');
  });

  it('says nothing about sources for a plain default', async () => {
    const { store } = await harness();
    const line = formatResolved(await store.resolve('gateway.port'));
    expect(line).toContain('default');
    expect(line).not.toContain('ROBIN_');
  });
});

describe('robin config list', () => {
  it('prints every key with its description', async () => {
    const { store, lines, out } = await harness();
    await runConfigList(store, out);
    const text = plain(lines);
    for (const key of ['browser', 'debug', 'default.model', 'gateway.port', 'local.baseUrl']) {
      expect(text).toContain(key);
    }
    expect(text).toContain('Port the gateway listens on');
  });
});

describe('robin config get', () => {
  it('prints the effective value', async () => {
    const { store, lines, out } = await harness();
    await store.set('gateway.port', '7777');
    await runConfigGet(store, 'gateway.port', out);
    expect(plain(lines)).toContain('7777');
  });

  it('refuses an unknown key and lists the real ones', async () => {
    const { store, out } = await harness();
    await expect(runConfigGet(store, 'nope', out)).rejects.toThrow(/gateway\.port/);
  });
});

describe('robin config set', () => {
  it('stores the value and confirms it', async () => {
    const { store, lines, out } = await harness();
    await runConfigSet(store, 'gateway.port', '7777', out);
    expect(await store.get('gateway.port')).toBe(7777);
    expect(plain(lines)).toContain('7777');
  });

  it('warns that the value will not take effect while an env var outranks it', async () => {
    const { store, lines, out } = await harness({ ROBIN_GATEWAY_PORT: '8080' });
    await runConfigSet(store, 'gateway.port', '7777', out);
    expect(plain(lines)).toContain('ROBIN_GATEWAY_PORT');
  });

  it('rejects a bad value', async () => {
    const { store, out } = await harness();
    await expect(runConfigSet(store, 'gateway.port', '99999', out)).rejects.toThrow();
  });
});

describe('robin config unset', () => {
  it('reverts to the default and says what it reverted to', async () => {
    const { store, lines, out } = await harness();
    await store.set('gateway.port', '7777');
    await runConfigUnset(store, 'gateway.port', out);
    expect(await store.get('gateway.port')).toBe(18790);
    expect(plain(lines)).toContain('18790');
  });
});
