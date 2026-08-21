import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadMcpConfig, serverFingerprint, addMcpServer, removeMcpServer } from '../../src/mcp/config';

async function withConfig(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-mcp-'));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, contents);
  return file;
}

describe('loadMcpConfig', () => {
  it('returns no servers when the file does not exist', async () => {
    expect(await loadMcpConfig(path.join(os.tmpdir(), 'robin-mcp-absent', 'mcp.json'))).toEqual([]);
  });

  it('reads a well-formed config', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } } })
    );

    expect(await loadMcpConfig(file)).toEqual([
      { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: undefined, cwd: undefined },
    ]);
  });

  it('fails closed on malformed JSON', async () => {
    expect(await loadMcpConfig(await withConfig('{ not json'))).toEqual([]);
  });

  it('fails closed on the wrong shape', async () => {
    expect(await loadMcpConfig(await withConfig('["nope"]'))).toEqual([]);
  });

  it('skips an entry with no command rather than failing the whole file', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { good: { command: 'a' }, bad: { args: ['x'] } } })
    );

    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['good']);
  });

  it('rejects a server name that would break the tool namespace', async () => {
    // "a__b" would make the server__tool split ambiguous, which is how a
    // server could shadow a built-in tool.
    const file = await withConfig(
      JSON.stringify({ servers: { a__b: { command: 'x' }, ok: { command: 'y' } } })
    );

    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['ok']);
  });

  it('rejects a server name with path characters', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { '../evil': { command: 'x' }, ok: { command: 'y' } } })
    );

    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['ok']);
  });

  it('reads a url-only entry as a remote server', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } } })
    );

    const loaded = await loadMcpConfig(file);
    expect(loaded).toEqual([
      {
        name: 'remote',
        command: undefined,
        args: undefined,
        env: undefined,
        cwd: undefined,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    ]);
  });

  it('skips an entry with neither command nor url', async () => {
    const file = await withConfig(JSON.stringify({ servers: { bad: { headers: {} }, ok: { command: 'x' } } }));
    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['ok']);
  });

  it('skips an entry with both command and url — ambiguous', async () => {
    const file = await withConfig(
      JSON.stringify({
        servers: { bad: { command: 'x', url: 'https://example.com' }, ok: { command: 'y' } },
      })
    );
    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['ok']);
  });

  it('skips an entry with an unparseable url', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { bad: { url: 'not a url' }, ok: { command: 'y' } } })
    );
    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['ok']);
  });
});

describe('serverFingerprint', () => {
  it('changes when the command changes', () => {
    const a = serverFingerprint('fs', { name: 'fs', command: 'npx', args: ['-y', 'x'] });
    const b = serverFingerprint('fs', { name: 'fs', command: 'npx', args: ['-y', 'y'] });
    expect(a).not.toBe(b);
  });

  it('is stable for the same entry', () => {
    const cfg = { name: 'fs', command: 'npx', args: ['-y', 'x'] };
    expect(serverFingerprint('fs', cfg)).toBe(serverFingerprint('fs', cfg));
  });

  it('ignores env values so a rotated token does not re-prompt', () => {
    const a = serverFingerprint('gh', { name: 'gh', command: 'x', env: { TOKEN: 'old' } });
    const b = serverFingerprint('gh', { name: 'gh', command: 'x', env: { TOKEN: 'new' } });
    expect(a).toBe(b);
  });

  it('still changes when a new env key appears', () => {
    const a = serverFingerprint('gh', { name: 'gh', command: 'x', env: { TOKEN: 'v' } });
    const b = serverFingerprint('gh', { name: 'gh', command: 'x', env: { TOKEN: 'v', EXTRA: 'v' } });
    expect(a).not.toBe(b);
  });

  it('changes when the url changes, for a remote entry', () => {
    const a = serverFingerprint('remote', { name: 'remote', url: 'https://a.example.com' });
    const b = serverFingerprint('remote', { name: 'remote', url: 'https://b.example.com' });
    expect(a).not.toBe(b);
  });

  it('ignores header values so a rotated token does not re-prompt', () => {
    const a = serverFingerprint('remote', {
      name: 'remote',
      url: 'https://a.example.com',
      headers: { Authorization: 'Bearer old' },
    });
    const b = serverFingerprint('remote', {
      name: 'remote',
      url: 'https://a.example.com',
      headers: { Authorization: 'Bearer new' },
    });
    expect(a).toBe(b);
  });

  it('still changes when a new header key appears', () => {
    const a = serverFingerprint('remote', {
      name: 'remote',
      url: 'https://a.example.com',
      headers: { Authorization: 'Bearer v' },
    });
    const b = serverFingerprint('remote', {
      name: 'remote',
      url: 'https://a.example.com',
      headers: { Authorization: 'Bearer v', 'X-Extra': 'v' },
    });
    expect(a).not.toBe(b);
  });

  it('never collides between a local and a remote entry of the same name', () => {
    const local = serverFingerprint('svc', { name: 'svc', command: 'npx' });
    const remote = serverFingerprint('svc', { name: 'svc', url: 'https://example.com/mcp' });
    expect(local).not.toBe(remote);
  });
});

describe('loadMcpConfig and the mcpServers spelling', () => {
  // Claude Desktop, Cursor and most other hosts key this "mcpServers". Robin
  // documented "the same shape other MCP hosts use" while only reading
  // "servers", so a block pasted from any of their docs silently did nothing.
  it('reads a config written with mcpServers', async () => {
    const file = await withConfig(
      JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } } })
    );

    expect(await loadMcpConfig(file)).toEqual([
      { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: undefined, cwd: undefined },
    ]);
  });

  it('still reads a config written with servers', async () => {
    const file = await withConfig(JSON.stringify({ servers: { fs: { command: 'x' } } }));
    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['fs']);
  });

  it('takes both when a file has both', async () => {
    const file = await withConfig(
      JSON.stringify({ servers: { a: { command: 'x' } }, mcpServers: { b: { command: 'y' } } })
    );

    expect((await loadMcpConfig(file)).map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  // Robin's own spelling is the documented one, so it decides.
  it('prefers the servers entry when a name appears under both', async () => {
    const file = await withConfig(
      JSON.stringify({
        servers: { same: { command: 'from-servers' } },
        mcpServers: { same: { command: 'from-mcpServers' } },
      })
    );

    const loaded = await loadMcpConfig(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].command).toBe('from-servers');
  });

  it('returns nothing when neither key is present', async () => {
    const file = await withConfig(JSON.stringify({ somethingElse: {} }));
    expect(await loadMcpConfig(file)).toEqual([]);
  });
});

describe('addMcpServer', () => {
  async function freshPath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-mcp-add-'));
    return path.join(dir, 'mcp.json');
  }

  it('creates a missing file', async () => {
    const file = await freshPath();
    await addMcpServer({ name: 'fs', command: 'npx', args: ['-y', 'x'] }, file);
    expect(await loadMcpConfig(file)).toEqual([
      { name: 'fs', command: 'npx', args: ['-y', 'x'], env: undefined, cwd: undefined },
    ]);
  });

  it('preserves unrelated top-level keys', async () => {
    const file = await withConfig(JSON.stringify({ somethingElse: { keep: true }, servers: {} }));
    await addMcpServer({ name: 'fs', command: 'npx' }, file);

    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(raw.somethingElse).toEqual({ keep: true });
  });

  it('writes under servers even when the file only had mcpServers', async () => {
    const file = await withConfig(JSON.stringify({ mcpServers: { other: { command: 'y' } } }));
    await addMcpServer({ name: 'fs', command: 'npx' }, file);

    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(raw.servers.fs).toBeDefined();
    expect(raw.mcpServers.other).toBeDefined();
    // loadMcpConfig merges both, so the addition is actually usable.
    expect((await loadMcpConfig(file)).map((s) => s.name).sort()).toEqual(['fs', 'other']);
  });

  it('adds env values, which round-trip through loadMcpConfig', async () => {
    const file = await freshPath();
    await addMcpServer({ name: 'gh', command: 'npx', env: { TOKEN: 'abc' } }, file);
    expect((await loadMcpConfig(file))[0].env).toEqual({ TOKEN: 'abc' });
  });

  it('overwrites an existing entry of the same name rather than duplicating it', async () => {
    const file = await withConfig(JSON.stringify({ servers: { fs: { command: 'old' } } }));
    await addMcpServer({ name: 'fs', command: 'new' }, file);
    expect((await loadMcpConfig(file)).map((s) => s.command)).toEqual(['new']);
  });

  it('throws without writing when the existing file fails to parse', async () => {
    const file = await withConfig('{ not json');
    await expect(addMcpServer({ name: 'fs', command: 'npx' }, file)).rejects.toThrow(file);
    expect(await fs.readFile(file, 'utf-8')).toBe('{ not json');
  });
});

describe('removeMcpServer', () => {
  it('deletes an entry under servers', async () => {
    const file = await withConfig(JSON.stringify({ servers: { fs: { command: 'x' }, gh: { command: 'y' } } }));
    expect(await removeMcpServer('fs', file)).toBe(true);
    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['gh']);
  });

  it('deletes an entry under mcpServers too', async () => {
    const file = await withConfig(JSON.stringify({ mcpServers: { fs: { command: 'x' } } }));
    expect(await removeMcpServer('fs', file)).toBe(true);
    expect(await loadMcpConfig(file)).toEqual([]);
  });

  it('returns false for a name that was never there', async () => {
    const file = await withConfig(JSON.stringify({ servers: { fs: { command: 'x' } } }));
    expect(await removeMcpServer('nope', file)).toBe(false);
    // Untouched — the existing entry survives a no-op remove.
    expect((await loadMcpConfig(file)).map((s) => s.name)).toEqual(['fs']);
  });

  it('returns false when the file does not exist', async () => {
    const file = path.join(os.tmpdir(), 'robin-mcp-remove-absent', 'mcp.json');
    expect(await removeMcpServer('fs', file)).toBe(false);
  });
});
