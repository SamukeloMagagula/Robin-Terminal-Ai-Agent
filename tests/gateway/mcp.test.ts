import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startTrustedMcpServers } from '../../src/gateway/mcp';
import { TrustStore } from '../../src/trust-store';
import { serverFingerprint, type McpServerConfig } from '../../src/mcp/config';

async function throwawayTrust(): Promise<TrustStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-mcptrust-'));
  return new TrustStore(path.join(dir, 'trust.json'));
}

const server: McpServerConfig = { name: 'files', command: 'npx', args: ['-y', 'some-server'] };

describe('startTrustedMcpServers', () => {
  it('starts nothing when nothing is configured', async () => {
    const load = vi.fn().mockResolvedValue([]);
    const connect = vi.fn();

    const result = await startTrustedMcpServers({
      trustStore: await throwawayTrust(),
      loadConfig: load,
      connect,
      log: () => {},
    });

    expect(connect).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  // The daemon runs detached with no terminal. A server it has not been told
  // to trust cannot be approved here, and launching it anyway would be running
  // a command from a config file nobody agreed to.
  it('skips a server that has not been trusted, rather than asking', async () => {
    const connect = vi.fn();

    const result = await startTrustedMcpServers({
      trustStore: await throwawayTrust(),
      loadConfig: vi.fn().mockResolvedValue([server]),
      connect,
      log: () => {},
    });

    expect(connect).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(['files']);
    expect(result.started).toEqual([]);
  });

  it('starts a server that was trusted earlier', async () => {
    const trustStore = await throwawayTrust();
    await trustStore.trustContent('mcp-server', server.name, serverFingerprint(server.name, server));
    const connect = vi.fn().mockResolvedValue(undefined);

    const result = await startTrustedMcpServers({
      trustStore,
      loadConfig: vi.fn().mockResolvedValue([server]),
      connect,
      log: () => {},
    });

    expect(connect).toHaveBeenCalledWith([server]);
    expect(result.started).toEqual(['files']);
    expect(result.skipped).toEqual([]);
  });

  // Trusting the exact entry means a changed command is a new decision.
  it('skips a trusted server whose command has changed', async () => {
    const trustStore = await throwawayTrust();
    await trustStore.trustContent('mcp-server', server.name, serverFingerprint(server.name, server));
    const changed = { ...server, args: ['-y', 'something-else'] };

    const result = await startTrustedMcpServers({
      trustStore,
      loadConfig: vi.fn().mockResolvedValue([changed]),
      connect: vi.fn(),
      log: () => {},
    });

    expect(result.skipped).toEqual(['files']);
  });

  it('says what it skipped, so the silence is explainable', async () => {
    const lines: string[] = [];

    await startTrustedMcpServers({
      trustStore: await throwawayTrust(),
      loadConfig: vi.fn().mockResolvedValue([server]),
      connect: vi.fn(),
      log: (line) => lines.push(line),
    });

    const said = lines.join('\n');
    expect(said).toContain('files');
    expect(said).toContain('robin mcp');
  });

  // A broken server must not stop the daemon coming up at all.
  it('survives a server that fails to connect', async () => {
    const trustStore = await throwawayTrust();
    await trustStore.trustContent('mcp-server', server.name, serverFingerprint(server.name, server));

    const result = await startTrustedMcpServers({
      trustStore,
      loadConfig: vi.fn().mockResolvedValue([server]),
      connect: vi.fn().mockRejectedValue(new Error('spawn failed')),
      log: () => {},
    });

    expect(result.started).toEqual([]);
  });

  it('survives an unreadable mcp.json', async () => {
    const result = await startTrustedMcpServers({
      trustStore: await throwawayTrust(),
      loadConfig: vi.fn().mockRejectedValue(new Error('bad json')),
      connect: vi.fn(),
      log: () => {},
    });

    expect(result.started).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
