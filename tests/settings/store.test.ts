import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SettingsStore } from '../../src/settings/store';

async function store(
  env: NodeJS.ProcessEnv = {},
  warn: (line: string) => void = () => {}
): Promise<{ file: string; store: SettingsStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-settings-'));
  const file = path.join(dir, 'settings.json');
  return { file, store: new SettingsStore(file, env, warn) };
}

async function write(file: string, contents: string): Promise<void> {
  await fs.writeFile(file, contents, 'utf-8');
}

describe('SettingsStore', () => {
  it('falls back to built-in defaults when there is no file', async () => {
    const { store: s } = await store();
    const resolved = await s.resolve('gateway.port');
    expect(resolved.value).toBe(18790);
    expect(resolved.source).toBe('default');
  });

  it('round-trips a value that was set', async () => {
    const { store: s } = await store();
    await s.set('gateway.port', '7777');
    const resolved = await s.resolve('gateway.port');
    expect(resolved.value).toBe(7777);
    expect(resolved.source).toBe('file');
  });

  it('creates the containing directory rather than failing on a fresh install', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-settings-'));
    const file = path.join(dir, 'nested', 'settings.json');
    const s = new SettingsStore(file, {}, () => {});
    await s.set('debug', 'true');
    expect(await s.get('debug')).toBe(true);
  });

  it('forgets a value that was unset, reverting to the default', async () => {
    const { store: s } = await store();
    await s.set('gateway.port', '7777');
    await s.unset('gateway.port');
    const resolved = await s.resolve('gateway.port');
    expect(resolved.value).toBe(18790);
    expect(resolved.source).toBe('default');
  });

  it('leaves other settings alone when one is unset', async () => {
    const { store: s } = await store();
    await s.set('gateway.port', '7777');
    await s.set('debug', 'true');
    await s.unset('gateway.port');
    expect(await s.get('debug')).toBe(true);
  });

  it('refuses an unknown key and names the ones that exist', async () => {
    const { store: s } = await store();
    await expect(s.set('gateway.prot', '7777')).rejects.toThrow(/gateway\.port/);
  });

  it('refuses an invalid value and writes nothing', async () => {
    const { file, store: s } = await store();
    await expect(s.set('gateway.port', '99999')).rejects.toThrow();
    await expect(fs.readFile(file, 'utf-8')).rejects.toThrow();
  });
});

describe('SettingsStore precedence', () => {
  it('lets the environment win over the file, and says so', async () => {
    const { file, store: s } = await store({ ROBIN_GATEWAY_PORT: '8080' });
    await write(file, JSON.stringify({ 'gateway.port': 7777 }));
    const resolved = await s.resolve('gateway.port');
    expect(resolved.value).toBe(8080);
    expect(resolved.source).toBe('env');
    expect(resolved.shadowed).toBe(7777);
  });

  it('reports no shadowing when the environment is the only source', async () => {
    const { store: s } = await store({ ROBIN_GATEWAY_PORT: '8080' });
    const resolved = await s.resolve('gateway.port');
    expect(resolved.source).toBe('env');
    expect(resolved.shadowed).toBeUndefined();
  });

  it('uses the file when the environment variable is set but unusable', async () => {
    const { file, store: s } = await store({ ROBIN_GATEWAY_PORT: 'nonsense' });
    await write(file, JSON.stringify({ 'gateway.port': 7777 }));
    const resolved = await s.resolve('gateway.port');
    expect(resolved.value).toBe(7777);
    expect(resolved.source).toBe('file');
  });

  it('inverts ROBIN_NO_HISTORY_FILE when resolving history.enabled', async () => {
    const { store: s } = await store({ ROBIN_NO_HISTORY_FILE: '1' });
    expect(await s.get('history.enabled')).toBe(false);
  });

  it('resolves every known setting at once, in registry order', async () => {
    const { store: s } = await store();
    const all = await s.resolveAll();
    expect(all.map((r) => r.setting.key)).toEqual([
      'browser',
      'debug',
      'default.model',
      'default.provider',
      'gateway.port',
      'history.enabled',
      'local.baseUrl',
      'media.imageModel',
      'media.speechModel',
      'media.transcribeModel',
    ]);
  });
});

describe('SettingsStore given a damaged file', () => {
  it('warns once and carries on with defaults rather than throwing', async () => {
    const lines: string[] = [];
    const { file, store: s } = await store({}, (line) => lines.push(line));
    await write(file, '{ not json');
    expect(await s.get('gateway.port')).toBe(18790);
    await s.get('debug');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(file);
  });

  it('ignores a stored value whose type is wrong for the key', async () => {
    const { file, store: s } = await store();
    await write(file, JSON.stringify({ 'gateway.port': 'eighty' }));
    const resolved = await s.resolve('gateway.port');
    expect(resolved.value).toBe(18790);
    expect(resolved.source).toBe('default');
  });

  it('ignores a stored key that is not in the registry', async () => {
    const { file, store: s } = await store();
    await write(file, JSON.stringify({ 'gateway.port': 7777, 'made.up': 'x' }));
    expect(await s.get('gateway.port')).toBe(7777);
    expect((await s.resolveAll()).map((r) => r.setting.key)).not.toContain('made.up');
  });

  it('preserves an unrecognised key already in the file when writing another', async () => {
    const { file, store: s } = await store();
    await write(file, JSON.stringify({ 'made.up': 'x' }));
    await s.set('debug', 'true');
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
    expect(raw['made.up']).toBe('x');
    expect(raw.debug).toBe(true);
  });
});
