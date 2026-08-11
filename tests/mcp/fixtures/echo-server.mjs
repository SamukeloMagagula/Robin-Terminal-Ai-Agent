// A minimal real MCP server over stdio, used by tests/mcp/client.test.ts.
//
// Deliberately a real child process rather than a mocked transport: mocking
// the transport would prove nothing about whether Robin's integration with the
// SDK actually works, which is the only thing these tests exist to check.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'echo-server', version: '0.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the given text back.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') {
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
  const text = request.params.arguments?.text ?? '';
  return { content: [{ type: 'text', text: `echo: ${text}` }] };
});

await server.connect(new StdioServerTransport());
