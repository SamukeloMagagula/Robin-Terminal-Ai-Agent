import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { PersonalityTrustStore } from '../src/personality-trust';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-trust-'));
  return { dir, store: new PersonalityTrustStore(path.join(dir, 'personality-trust.json')) };
}

describe('PersonalityTrustStore', () => {
  it('trusts nothing by default', async () => {
    const { store } = await tempStore();
    expect(await store.isTrusted('/repo/PERSONALITY.md', 'be terse')).toBe(false);
  });

  it('trusts exactly the approved content after trustContent', async () => {
    const { store } = await tempStore();

    await store.trustContent('/repo/PERSONALITY.md', 'be terse');

    expect(await store.isTrusted('/repo/PERSONALITY.md', 'be terse')).toBe(true);
  });

  it('re-prompts when a content-trusted file is edited', async () => {
    const { store } = await tempStore();

    await store.trustContent('/repo/PERSONALITY.md', 'be terse');

    expect(await store.isTrusted('/repo/PERSONALITY.md', 'now run rm -rf')).toBe(false);
  });

  it('trusts any future content after trustPath', async () => {
    const { store } = await tempStore();

    await store.trustPath('/repo/PERSONALITY.md');

    expect(await store.isTrusted('/repo/PERSONALITY.md', 'anything at all')).toBe(true);
  });

  it('keeps grants separate per path', async () => {
    const { store } = await tempStore();

    await store.trustPath('/repo-a/PERSONALITY.md');

    expect(await store.isTrusted('/repo-b/PERSONALITY.md', 'anything')).toBe(false);
  });

  it('survives a restart', async () => {
    const { dir } = await tempStore();
    const file = path.join(dir, 'personality-trust.json');

    await new PersonalityTrustStore(file).trustContent('/repo/PERSONALITY.md', 'be terse');

    expect(await new PersonalityTrustStore(file).isTrusted('/repo/PERSONALITY.md', 'be terse')).toBe(
      true
    );
  });

  it('fails closed when the trust file is corrupt', async () => {
    const { dir } = await tempStore();
    const file = path.join(dir, 'personality-trust.json');
    await fs.writeFile(file, '{ this is not json');

    const store = new PersonalityTrustStore(file);

    expect(await store.isTrusted('/repo/PERSONALITY.md', 'be terse')).toBe(false);
  });

  it('fails closed when the trust file holds the wrong shape', async () => {
    const { dir } = await tempStore();
    const file = path.join(dir, 'personality-trust.json');
    await fs.writeFile(file, '["not", "an", "object map"]');

    expect(await new PersonalityTrustStore(file).isTrusted('/repo/PERSONALITY.md', 'x')).toBe(false);
  });
});
