import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadMcpConfig, serverFingerprint } from '../../src/mcp/config';

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
});
