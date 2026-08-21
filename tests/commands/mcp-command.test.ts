import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { runMcpSearch, runMcpRemove } from '../../src/commands/mcp-command';
import type { RegistryServer } from '../../src/mcp/catalogue';
import { loadMcpConfig } from '../../src/mcp/config';

async function withConfig(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-mcp-cmd-'));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, contents);
  return file;
}

const installable: RegistryServer = {
  name: 'io.github.acme/filesystem',
  description: 'Filesystem access',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'remote-filesystem-mcp-server',
      version: '0.1.2',
      runtimeHint: 'npx',
    },
  ],
};

const remoteOnly: RegistryServer = {
  name: 'io.github.acme/hosted',
  description: 'Hosted only',
  version: '1.0.0',
  remotes: [{ type: 'streamable-http', url: 'https://example.com' }],
};

function fetchReturning(servers: RegistryServer[]): typeof fetch {
  const entries = servers.map((server) => ({
    server,
    _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
  }));
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ servers: entries, metadata: { count: entries.length } }),
  }) as unknown as typeof fetch;
}

let logSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  logSpy?.mockRestore();
});

function printed(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('runMcpSearch', () => {
  it('shows the mapped command for an installable server', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMcpSearch('filesystem', fetchReturning([installable]));

    const out = printed();
    expect(out).toContain('io.github.acme/filesystem');
    expect(out).toContain('npx');
  });

  it('says why a remotes-only server cannot be installed', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMcpSearch('hosted', fetchReturning([remoteOnly]));

    const out = printed();
    expect(out).toContain('io.github.acme/hosted');
    expect(out.toLowerCase()).toMatch(/not installable|remote|http/);
  });
});

describe('runMcpRemove', () => {
  it('removes an existing entry', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = await withConfig(JSON.stringify({ servers: { fs: { command: 'x' } } }));

    await runMcpRemove('fs', file);

    expect(await loadMcpConfig(file)).toEqual([]);
    expect(printed()).toContain('fs');
  });

  it('says plainly when there was nothing to remove, without erroring', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = await withConfig(JSON.stringify({ servers: {} }));

    await runMcpRemove('nope', file);

    expect(printed().toLowerCase()).toContain('no');
  });
});
