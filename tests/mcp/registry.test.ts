import { describe, it, expect, vi } from 'vitest';
import { McpRegistry, namespacedName, splitNamespaced } from '../../src/mcp/registry';
import type { McpConnectionLike } from '../../src/mcp/registry';
import type { McpToolInfo } from '../../src/mcp/client';
import type { McpServerConfig } from '../../src/mcp/config';

function stubConnection(tools: McpToolInfo[], overrides: Partial<McpConnectionLike> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue('stub result'),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as McpConnectionLike & { connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

function tool(name: string): McpToolInfo {
  return { name, description: `the ${name} tool`, inputSchema: { type: 'object' } };
}

function server(name: string): McpServerConfig {
  return { name, command: 'x' };
}

describe('namespacedName / splitNamespaced', () => {
  it('round-trips', () => {
    expect(splitNamespaced(namespacedName('fs', 'read_file'))).toEqual({
      server: 'fs',
      tool: 'read_file',
    });
  });

  it('returns undefined for a bare built-in name', () => {
    expect(splitNamespaced('read_file')).toBeUndefined();
  });

  it('splits on the first separator, so a tool name may contain one', () => {
    expect(splitNamespaced('fs__odd__name')).toEqual({ server: 'fs', tool: 'odd__name' });
  });
});

describe('McpRegistry', () => {
  it('namespaces tools and does not claim the bare built-in name', async () => {
    // The whole point of the prefix: a server declaring read_file must not be
    // able to intercept calls meant for Robin's own read_file.
    const registry = new McpRegistry({
      createConnection: () => stubConnection([tool('read_file')]),
    });

    await registry.load([server('fs')]);

    expect(registry.toolDefinitions().map((t) => t.name)).toEqual(['fs__read_file']);
    expect(registry.has('fs__read_file')).toBe(true);
    expect(registry.has('read_file')).toBe(false);
  });

  it('keeps same-named tools from different servers distinct', async () => {
    const registry = new McpRegistry({
      createConnection: () => stubConnection([tool('search')]),
    });

    await registry.load([server('a'), server('b')]);

    expect(registry.toolDefinitions().map((t) => t.name).sort()).toEqual([
      'a__search',
      'b__search',
    ]);
  });

  it('carries the server name into the description so the model can tell them apart', async () => {
    const registry = new McpRegistry({
      createConnection: () => stubConnection([tool('search')]),
    });

    await registry.load([server('github')]);

    expect(registry.toolDefinitions()[0].description).toContain('github');
  });

  it('isolates a server that fails to connect', async () => {
    const onError = vi.fn();
    const registry = new McpRegistry({
      createConnection: (config) =>
        config.name === 'broken'
          ? stubConnection([], { connect: vi.fn().mockRejectedValue(new Error('boom')) })
          : stubConnection([tool('ok')]),
      onError,
    });

    await registry.load([server('broken'), server('good')]);

    expect(registry.toolDefinitions().map((t) => t.name)).toEqual(['good__ok']);
    expect(onError).toHaveBeenCalledWith('broken', expect.stringContaining('boom'));
  });

  it('isolates a server whose tool listing fails', async () => {
    const onError = vi.fn();
    const registry = new McpRegistry({
      createConnection: () =>
        stubConnection([], { listTools: vi.fn().mockRejectedValue(new Error('no tools')) }),
      onError,
    });

    await registry.load([server('flaky')]);

    expect(registry.toolDefinitions()).toEqual([]);
    expect(onError).toHaveBeenCalledWith('flaky', expect.stringContaining('no tools'));
  });

  it('routes a call to the owning server with the un-namespaced tool name', async () => {
    const connection = stubConnection([tool('echo')]);
    const registry = new McpRegistry({ createConnection: () => connection });
    await registry.load([server('fs')]);

    await registry.call('fs__echo', { text: 'hi' });

    expect(connection.callTool).toHaveBeenCalledWith('echo', { text: 'hi' });
  });

  it('returns an error string for an unknown tool rather than throwing', async () => {
    const registry = new McpRegistry({ createConnection: () => stubConnection([]) });
    await registry.load([server('fs')]);

    await expect(registry.call('fs__nope', {})).resolves.toMatch(/unknown|not available/i);
  });

  it('closes every connection, including after one failed to connect', async () => {
    const broken = stubConnection([], { connect: vi.fn().mockRejectedValue(new Error('boom')) });
    const good = stubConnection([tool('ok')]);
    const registry = new McpRegistry({
      createConnection: (config) => (config.name === 'broken' ? broken : good),
      onError: () => {},
    });
    await registry.load([server('broken'), server('good')]);

    await registry.closeAll();

    expect(good.close).toHaveBeenCalled();
    expect(broken.close).toHaveBeenCalled();
  });

  it('loading no servers yields no tools and connects nothing', async () => {
    const createConnection = vi.fn();
    const registry = new McpRegistry({ createConnection });

    await registry.load([]);

    expect(registry.toolDefinitions()).toEqual([]);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('counts servers, not tools', async () => {
    // The HUD meter read 1 whenever any tool existed, so three servers showed
    // as one. Counting connections is the fix; this pins it.
    const registry = new McpRegistry({
      createConnection: () => stubConnection([tool('a'), tool('b')]),
    });

    await registry.load([server('one'), server('two'), server('three')]);

    expect(registry.toolDefinitions()).toHaveLength(6);
    expect(registry.serverCount()).toBe(3);
  });

  it('counts a connected server that exposes no tools', async () => {
    const registry = new McpRegistry({ createConnection: () => stubConnection([]) });

    await registry.load([server('quiet')]);

    // It is running; the meter must not report it as absent.
    expect(registry.serverCount()).toBe(1);
  });

  it('does not count a server that failed to connect', async () => {
    const registry = new McpRegistry({
      createConnection: () =>
        stubConnection([], { connect: vi.fn().mockRejectedValue(new Error('boom')) }),
      onError: () => {},
    });

    await registry.load([server('broken')]);

    expect(registry.serverCount()).toBe(0);
  });
});
