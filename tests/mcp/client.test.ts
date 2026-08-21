import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpConnection } from '../../src/mcp/client';
import type { McpServerConfig } from '../../src/mcp/config';

const ECHO_SERVER = path.resolve('tests/mcp/fixtures/echo-server.mjs');

function echoConfig(): McpServerConfig {
  return { name: 'echo', command: process.execPath, args: [ECHO_SERVER] };
}

/**
 * A real Streamable-HTTP MCP server, in-process — a real socket and the
 * SDK's own request handling, not a mocked transport, for the same reason
 * echo-server.mjs runs as a real child process for the stdio case.
 */
async function startHttpEchoServer(): Promise<{
  url: string;
  receivedHeaders: http.IncomingHttpHeaders[];
  close: () => Promise<void>;
}> {
  const receivedHeaders: http.IncomingHttpHeaders[] = [];
  const mcpServer = new McpServer(
    { name: 'echo-http-server', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo the given text back.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'echo') {
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
    }
    const text = (request.params.arguments as { text?: string } | undefined)?.text ?? '';
    return { content: [{ type: 'text', text: `echo: ${text}` }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    receivedHeaders.push(req.headers);
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    receivedHeaders,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
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

  it('connects to a real Streamable-HTTP server, lists and calls a tool', async () => {
    const httpServer = await startHttpEchoServer();
    const connection = new McpConnection({ name: 'remote', url: httpServer.url });
    try {
      await connection.connect();
      const tools = await connection.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('echo');

      const result = await connection.callTool('echo', { text: 'hi' });
      expect(result).toContain('echo: hi');
    } finally {
      // The client's standalone SSE stream stays open until the client
      // closes it — http.Server.close() waits for existing connections to
      // end, so it must come after the connection is closed, or it hangs.
      await connection.close();
      await httpServer.close();
    }
  }, 30_000);

  it('sends the configured headers on a Streamable-HTTP connection', async () => {
    const httpServer = await startHttpEchoServer();
    const connection = new McpConnection({
      name: 'remote',
      url: httpServer.url,
      headers: { Authorization: 'Bearer secret-token' },
    });
    try {
      await connection.connect();

      const sawAuthHeader = httpServer.receivedHeaders.some(
        (h) => h.authorization === 'Bearer secret-token'
      );
      expect(sawAuthHeader).toBe(true);
    } finally {
      await connection.close();
      await httpServer.close();
    }
  }, 30_000);

  it('rejects rather than hanging when the remote url is unreachable', async () => {
    const connection = track(
      new McpConnection({ name: 'bad', url: 'http://127.0.0.1:1' }, 5_000)
    );

    await expect(connection.connect()).rejects.toThrow();
  }, 30_000);
});
