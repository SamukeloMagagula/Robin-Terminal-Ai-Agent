import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { McpConnection } from '../../src/mcp/client';
import type { McpServerConfig } from '../../src/mcp/config';

const ECHO_SERVER = path.resolve('tests/mcp/fixtures/echo-server.mjs');

function echoConfig(): McpServerConfig {
  return { name: 'echo', command: process.execPath, args: [ECHO_SERVER] };
}

const open: McpConnection[] = [];

function track(connection: McpConnection): McpConnection {
  open.push(connection);
  return connection;
}

afterEach(async () => {
  // A leaked child process keeps the vitest worker alive.
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe('McpConnection', () => {
  it('connects to a real stdio server and lists its tools', async () => {
    const connection = track(new McpConnection(echoConfig()));

    await connection.connect();
    const tools = await connection.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('echo');
    expect(tools[0].description).toContain('Echo');
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' });
  }, 30_000);

  it('calls a tool and returns its text content', async () => {
    const connection = track(new McpConnection(echoConfig()));
    await connection.connect();

    const result = await connection.callTool('echo', { text: 'hello' });

    expect(result).toContain('echo: hello');
  }, 30_000);

  it('reports a tool error as text rather than throwing', async () => {
    const connection = track(new McpConnection(echoConfig()));
    await connection.connect();

    const result = await connection.callTool('nope', {});

    expect(result).toMatch(/unknown tool/i);
  }, 30_000);

  it('rejects rather than hanging when the command does not exist', async () => {
    const connection = track(
      new McpConnection({ name: 'bad', command: 'definitely-not-a-real-binary-xyz' }, 5_000)
    );

    await expect(connection.connect()).rejects.toThrow();
  }, 30_000);

  it('close() is safe to call twice', async () => {
    const connection = new McpConnection(echoConfig());
    await connection.connect();

    await connection.close();
    await expect(connection.close()).resolves.toBeUndefined();
  }, 30_000);
});
