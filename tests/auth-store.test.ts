import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuthStore } from '../src/auth-store';

describe('AuthStore', () => {
  let tmpFile: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-store-test-'));
    tmpFile = path.join(dir, 'auth.json');
  });

  it('returns empty object when file does not exist', async () => {
    const store = new AuthStore(tmpFile);
    expect(await store.read()).toEqual({});
  });

  it('round-trips a value through set/get', async () => {
    const store = new AuthStore(tmpFile);
    await store.set('copilot', { token: 'abc123' });
    expect(await store.get('copilot')).toEqual({ token: 'abc123' });
  });

  it('deletes a stored value', async () => {
    const store = new AuthStore(tmpFile);
    await store.set('copilot', { token: 'abc123' });
    await store.delete('copilot');
    expect(await store.get('copilot')).toBeUndefined();
  });

  it('preserves other providers when setting one', async () => {
    const store = new AuthStore(tmpFile);
    await store.set('copilot', { token: 'a' });
    await store.set('ollama', { note: 'b' });
    expect(await store.get('copilot')).toEqual({ token: 'a' });
    expect(await store.get('ollama')).toEqual({ note: 'b' });
  });
});
