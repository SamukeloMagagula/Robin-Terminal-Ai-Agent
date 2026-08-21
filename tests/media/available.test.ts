import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { AuthStore } from '../../src/auth-store';
import { SettingsStore } from '../../src/settings/store';
import { mediaIfAvailable, mediaModels } from '../../src/media/available';

async function stores(): Promise<{ auth: AuthStore; settings: SettingsStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-media-avail-'));
  return {
    auth: new AuthStore(path.join(dir, 'auth.json')),
    settings: new SettingsStore(path.join(dir, 'settings.json'), {}, () => {}),
  };
}

describe('mediaIfAvailable', () => {
  it('is unavailable when Gemini is not logged in', async () => {
    const { auth, settings } = await stores();
    expect(await mediaIfAvailable(auth, settings)).toBeUndefined();
  });

  it('is available once Gemini has a key', async () => {
    const { auth, settings } = await stores();
    await auth.set('gemini', { apiKey: 'key-123' });
    expect(await mediaIfAvailable(auth, settings)).toBeDefined();
  });

  it('is unavailable when the stored gemini entry has no key', async () => {
    const { auth, settings } = await stores();
    await auth.set('gemini', { somethingElse: true });
    expect(await mediaIfAvailable(auth, settings)).toBeUndefined();
  });
});

describe('mediaModels', () => {
  it('uses the configured defaults', async () => {
    const { settings } = await stores();
    const models = await mediaModels(settings);
    expect(models.image).toBe('gemini-2.5-flash-image');
  });

  it('honours a model the user set, so a rename needs no release', async () => {
    const { settings } = await stores();
    await settings.set('media.imageModel', 'gemini-9-image');
    expect((await mediaModels(settings)).image).toBe('gemini-9-image');
  });

  it('includes a vision model for describe_screen', async () => {
    const { settings } = await stores();
    const models = await mediaModels(settings);
    expect(models.vision).toBeTruthy();
  });
});
