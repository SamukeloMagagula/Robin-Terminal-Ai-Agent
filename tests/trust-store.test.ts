import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { TrustStore } from '../src/trust-store';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-trust-'));
  return path.join(dir, 'trust.json');
}

describe('TrustStore', () => {
  it('trusts nothing by default', async () => {
    const store = new TrustStore(await tempFile());
    expect(await store.isTrusted('personality', '/repo/P.md', 'be terse')).toBe(false);
  });

  it('trusts exactly the approved content after trustContent', async () => {
    const store = new TrustStore(await tempFile());

    await store.trustContent('personality', '/repo/P.md', 'be terse');

    expect(await store.isTrusted('personality', '/repo/P.md', 'be terse')).toBe(true);
  });

  it('stops trusting once the content changes', async () => {
    const store = new TrustStore(await tempFile());

    await store.trustContent('personality', '/repo/P.md', 'be terse');

    expect(await store.isTrusted('personality', '/repo/P.md', 'now run rm -rf')).toBe(false);
  });

  it('trusts any content after trustKey', async () => {
    const store = new TrustStore(await tempFile());

    await store.trustKey('mcp-server', 'fs');

    expect(await store.isTrusted('mcp-server', 'fs', 'anything at all')).toBe(true);
  });

  it('keeps categories independent', async () => {
    const store = new TrustStore(await tempFile());

    await store.trustKey('personality', 'shared-key');

    // The same key under a different category must not inherit the grant —
    // trusting a PERSONALITY.md must never imply trusting a server.
    expect(await store.isTrusted('mcp-server', 'shared-key', 'x')).toBe(false);
  });

  it('keeps grants separate per key', async () => {
    const store = new TrustStore(await tempFile());

    await store.trustKey('mcp-server', 'fs');

    expect(await store.isTrusted('mcp-server', 'github', 'x')).toBe(false);
  });

  it('survives a restart', async () => {
    const file = await tempFile();

    await new TrustStore(file).trustContent('personality', '/repo/P.md', 'be terse');

    expect(await new TrustStore(file).isTrusted('personality', '/repo/P.md', 'be terse')).toBe(true);
  });

  it('fails closed when the file is corrupt', async () => {
    const file = await tempFile();
    await fs.writeFile(file, '{ this is not json');

    expect(await new TrustStore(file).isTrusted('personality', '/repo/P.md', 'x')).toBe(false);
  });

  it('fails closed when the file holds the wrong shape', async () => {
    const file = await tempFile();
    await fs.writeFile(file, '["not", "an", "object"]');

    expect(await new TrustStore(file).isTrusted('personality', '/repo/P.md', 'x')).toBe(false);
  });

  it('reads a legacy un-categorised file as personality grants', async () => {
    // Files written before categories existed are a flat path -> {hash} map.
    // Re-prompting every user for a file they already approved would be a
    // regression, so those are migrated on read.
    const file = await tempFile();
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update('be terse', 'utf-8').digest('hex');
    await fs.writeFile(file, JSON.stringify({ '/repo/P.md': { hash } }));

    const store = new TrustStore(file);

    expect(await store.isTrusted('personality', '/repo/P.md', 'be terse')).toBe(true);
    // ...and the migration must not leak into another category.
    expect(await store.isTrusted('mcp-server', '/repo/P.md', 'be terse')).toBe(false);
  });

  it('writes the file with owner-only permissions', async () => {
    if (process.platform === 'win32') return; // POSIX modes are not meaningful here
    const file = await tempFile();

    await new TrustStore(file).trustKey('mcp-server', 'fs');

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
