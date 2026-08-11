import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { filterTrustedServers, type TrustAnswer } from '../../src/mcp/trust';
import { TrustStore } from '../../src/trust-store';
import type { McpServerConfig } from '../../src/mcp/config';

async function store(): Promise<TrustStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-mcptrust-'));
  return new TrustStore(path.join(dir, 'trust.json'));
}

const fsServer: McpServerConfig = { name: 'fs', command: 'npx', args: ['-y', 'server-fs'] };

describe('filterTrustedServers', () => {
  it('skips a server the user declines, and does not record the refusal', async () => {
    const trust = await store();
    const prompt = vi.fn().mockResolvedValue('no');

    expect(await filterTrustedServers([fsServer], trust, prompt)).toEqual([]);
    // Asked again next time — a "no" is for this launch, not forever.
    expect(await filterTrustedServers([fsServer], trust, prompt)).toEqual([]);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('admits a server the user approves, and does not ask again', async () => {
    const trust = await store();
    const prompt = vi.fn().mockResolvedValue('yes');

    expect(await filterTrustedServers([fsServer], trust, prompt)).toEqual([fsServer]);
    expect(await filterTrustedServers([fsServer], trust, prompt)).toEqual([fsServer]);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('asks again when an approved entry changes its command', async () => {
    const trust = await store();
    const prompt = vi.fn().mockResolvedValue('yes');
    await filterTrustedServers([fsServer], trust, prompt);

    const tampered = { ...fsServer, args: ['-y', 'something-else'] };
    await filterTrustedServers([tampered], trust, prompt);

    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('does not ask again after "always", even when the command changes', async () => {
    const trust = await store();
    const prompt = vi.fn().mockResolvedValue('always');
    await filterTrustedServers([fsServer], trust, prompt);

    const changed = { ...fsServer, command: 'something-entirely-different' };
    const result = await filterTrustedServers([changed], trust, prompt);

    expect(result).toEqual([changed]);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('decides each server independently', async () => {
    const trust = await store();
    const other: McpServerConfig = { name: 'github', command: 'gh-mcp' };
    const prompt = vi.fn(
      async (c: McpServerConfig): Promise<TrustAnswer> => (c.name === 'fs' ? 'yes' : 'no')
    );

    const result = await filterTrustedServers([fsServer, other], trust, prompt);

    expect(result.map((s) => s.name)).toEqual(['fs']);
  });

  it('never prompts when there are no servers', async () => {
    const prompt = vi.fn();
    expect(await filterTrustedServers([], await store(), prompt)).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
  });
});
