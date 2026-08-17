import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from './config.js';
import { robinVersion } from '../version.js';

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON schema, as the server declared it. */
  inputSchema: Record<string, unknown>;
}

/**
 * Without a cap, a server that starts but never completes the handshake holds
 * the whole turn. Ten seconds is generous for a local process launch.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/**
 * One connection to one MCP server, over stdio.
 *
 * Nothing is spawned until connect() is called, so a user who never enables
 * tools never pays for a server they configured months ago.
 */
export class McpConnection {
  private client: Client | undefined;
  private closed = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly startupTimeoutMs: number = DEFAULT_STARTUP_TIMEOUT_MS
  ) {}

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      // Passing env through unchanged rather than merging the parent's: a
      // server should see what mcp.json grants it, not Robin's whole
      // environment. The SDK supplies a safe default when this is undefined.
      env: this.config.env,
      cwd: this.config.cwd,
      // Server diagnostics must not interleave with Robin's own output.
      stderr: 'ignore',
    });

    const client = new Client({ name: 'robin', version: robinVersion() }, { capabilities: {} });

    await withTimeout(
      client.connect(transport),
      this.startupTimeoutMs,
      `MCP server "${this.config.name}" did not start within ${this.startupTimeoutMs / 1000}s`
    );
    this.client = client;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = this.require();
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }));
  }

  /**
   * Invokes a tool and flattens its reply to text.
   *
   * A tool-reported failure comes back as text rather than throwing: the model
   * can read an error and adapt, where an exception would abort the turn.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const client = this.require();
    const result = await client.callTool({ name, arguments: args });
    const text = flattenContent(result.content);
    return result.isError ? `Error: ${text}` : text;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client?.close();
    } catch {
      // Closing a connection that already died is not a failure worth raising.
    }
    this.client = undefined;
  }

  private require(): Client {
    if (!this.client) {
      throw new Error(`MCP server "${this.config.name}" is not connected.`);
    }
    return this.client;
  }
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      // Images and embedded resources have no useful text form here; naming
      // the type beats silently dropping the block.
      return `[${b.type ?? 'unknown'} content omitted]`;
    })
    .join('\n');
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
