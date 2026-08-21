import { describe, it, expect, vi } from 'vitest';
import { searchRegistry, installablePackage, commandFor, type RegistryServer } from '../../src/mcp/catalogue';

/** Wraps servers the way the real registry does: {server, _meta}, not flat. */
function envelope(server: RegistryServer, isLatest = true) {
  return {
    server,
    _meta: { 'io.modelcontextprotocol.registry/official': { isLatest } },
  };
}

function searchResponse(entries: unknown[], nextCursor?: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ servers: entries, metadata: { count: entries.length, nextCursor } }),
  }) as unknown as typeof fetch;
}

const npmServer: RegistryServer = {
  name: 'io.github.acme/filesystem',
  description: 'Filesystem access',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'remote-filesystem-mcp-server',
      version: '0.1.2',
      runtimeHint: 'npx',
      runtimeArguments: [{ value: '-y' }],
      environmentVariables: [
        { name: 'GCS_BUCKET', description: 'bucket', isRequired: true },
        { name: 'GCS_PRIVATE_KEY', description: 'key', isSecret: true },
      ],
    },
  ],
};

describe('searchRegistry', () => {
  it('sends the search term and limit as query params', async () => {
    const fetchImpl = searchResponse([]);
    await searchRegistry('filesystem', fetchImpl);

    const url = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(url).toContain('registry.modelcontextprotocol.io/v0/servers');
    expect(url).toContain('search=filesystem');
    expect(url).toContain('limit=');
  });

  it('unwraps the server from its envelope', async () => {
    const found = await searchRegistry('filesystem', searchResponse([envelope(npmServer)]));
    expect(found).toEqual([npmServer]);
  });

  it('reports a failed request rather than returning nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(searchRegistry('x', fetchImpl)).rejects.toThrow(/500/);
  });

  // The real registry can list several published versions of one server name.
  it('keeps only the version flagged isLatest when a name repeats', async () => {
    const old = { ...npmServer, version: '0.1.2' };
    const current = { ...npmServer, version: '0.1.3' };
    const fetchImpl = searchResponse([envelope(old, false), envelope(current, true)]);

    const found = await searchRegistry('filesystem', fetchImpl);

    expect(found).toHaveLength(1);
    expect(found[0].version).toBe('0.1.3');
  });

  it('falls back to the first seen version when none is flagged isLatest', async () => {
    const first = { ...npmServer, version: '0.1.2' };
    const second = { ...npmServer, version: '0.1.3' };
    const fetchImpl = searchResponse([envelope(first, false), envelope(second, false)]);

    const found = await searchRegistry('filesystem', fetchImpl);

    expect(found).toHaveLength(1);
    expect(found[0].version).toBe('0.1.2');
  });

  it('skips an entry with no server object', async () => {
    const fetchImpl = searchResponse([{ _meta: {} }, envelope(npmServer)]);
    expect(await searchRegistry('x', fetchImpl)).toEqual([npmServer]);
  });
});

describe('installablePackage', () => {
  it('picks the first package for a server that has packages', () => {
    expect(installablePackage(npmServer)).toBe(npmServer.packages[0]);
  });

  it('returns undefined for a remotes-only server with an empty packages array', () => {
    const remoteOnly: RegistryServer = {
      name: 'x',
      description: 'd',
      version: '1',
      packages: [],
      remotes: [{ type: 'streamable-http', url: 'https://example.com' }],
    };
    expect(installablePackage(remoteOnly)).toBeUndefined();
  });

  // The real registry omits `packages` entirely for a remotes-only server
  // rather than sending an empty array.
  it('returns undefined for a remotes-only server with packages absent', () => {
    const remoteOnly: RegistryServer = {
      name: 'x',
      description: 'd',
      version: '1',
      remotes: [{ type: 'streamable-http', url: 'https://example.com' }],
    };
    expect(installablePackage(remoteOnly)).toBeUndefined();
  });
});

describe('commandFor', () => {
  it('prefers runtimeHint when present', () => {
    expect(commandFor(npmServer.packages[0]).command).toBe('npx');
  });

  it('falls back to npx for an npm package with no runtimeHint', () => {
    const pkg = { registryType: 'npm' as const, identifier: 'foo-server', version: '2.0.0' };
    expect(commandFor(pkg)).toEqual({ command: 'npx', args: ['foo-server@2.0.0'] });
  });

  it('falls back to uvx for a pypi package with no runtimeHint', () => {
    const pkg = { registryType: 'pypi' as const, identifier: 'mcp-server-git', version: '1.5.2' };
    expect(commandFor(pkg)).toEqual({ command: 'uvx', args: ['mcp-server-git==1.5.2'] });
  });

  it('falls back to docker for a docker package with no runtimeHint', () => {
    const pkg = { registryType: 'docker' as const, identifier: 'acme/mcp-server', version: '3' };
    expect(commandFor(pkg)).toEqual({
      command: 'docker',
      args: ['run', '--rm', '-i', 'acme/mcp-server:3'],
    });
  });

  it('defaults the docker tag to latest when no version is given', () => {
    const pkg = { registryType: 'docker' as const, identifier: 'acme/mcp-server', version: '' };
    expect(commandFor(pkg).args).toContain('acme/mcp-server:latest');
  });

  it('includes runtimeArguments before the package identifier, in order', () => {
    const result = commandFor(npmServer.packages[0]);
    expect(result.args).toEqual(['-y', 'remote-filesystem-mcp-server@0.1.2']);
  });

  it('throws for an unrecognised registryType with no runtimeHint', () => {
    const pkg = { registryType: 'cargo' as const, identifier: 'x', version: '1' };
    expect(() => commandFor(pkg)).toThrow(/cargo/i);
  });
});
