import { describe, it, expect, vi } from 'vitest';
import { searchRegistry, installablePackage, commandFor, type RegistryServer } from '../../src/mcp/catalogue';

function searchResponse(servers: unknown[], nextCursor?: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ servers, metadata: { count: servers.length, nextCursor } }),
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

  it('returns the servers array', async () => {
    const found = await searchRegistry('filesystem', searchResponse([npmServer]));
    expect(found).toEqual([npmServer]);
  });

  it('reports a failed request rather than returning nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(searchRegistry('x', fetchImpl)).rejects.toThrow(/500/);
  });
});

describe('installablePackage', () => {
  it('picks the first package for a server that has packages', () => {
    expect(installablePackage(npmServer)).toBe(npmServer.packages[0]);
  });

  it('returns undefined for a remotes-only server', () => {
    const remoteOnly: RegistryServer = {
      name: 'x',
      description: 'd',
      version: '1',
      packages: [],
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
