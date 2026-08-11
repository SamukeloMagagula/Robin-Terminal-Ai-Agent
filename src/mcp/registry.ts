import type { ToolDefinition } from '../providers/types.js';
import type { McpServerConfig } from './config.js';
import { McpConnection, type McpToolInfo } from './client.js';

/** The part of McpConnection the registry needs, so tests can substitute one. */
export interface McpConnectionLike {
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Separates the server from the tool in an exposed tool name.
 *
 * Config rejects server names containing this sequence (see
 * `isValidServerName`), so the first occurrence is always the boundary.
 */
export const NAMESPACE_SEPARATOR = '__';

export function namespacedName(server: string, tool: string): string {
  return `${server}${NAMESPACE_SEPARATOR}${tool}`;
}

/**
 * Splits an exposed name back into its parts, or undefined if it carries no
 * namespace — which is how a built-in tool is recognised.
 *
 * Splits on the *first* separator: a server name can never contain one, but a
 * tool name might, and the server half is what must be unambiguous.
 */
export function splitNamespaced(name: string): { server: string; tool: string } | undefined {
  const index = name.indexOf(NAMESPACE_SEPARATOR);
  if (index <= 0) return undefined;
  const tool = name.slice(index + NAMESPACE_SEPARATOR.length);
  if (!tool) return undefined;
  return { server: name.slice(0, index), tool };
}

interface LoadedServer {
  name: string;
  connection: McpConnectionLike;
  tools: McpToolInfo[];
  /**
   * Whether the handshake succeeded. Tracked rather than inferred from
   * `tools.length`, because a server that connects and exposes nothing is
   * running — and a server that failed is kept in the list so closeAll can
   * still tear down a process that started before it broke.
   */
  connected: boolean;
}

export interface McpRegistryDeps {
  createConnection?: (config: McpServerConfig) => McpConnectionLike;
  /** Called instead of printing, so the registry stays free of terminal concerns. */
  onError?: (serverName: string, message: string) => void;
}

/**
 * Every MCP tool Robin can currently reach, keyed by its namespaced name.
 *
 * The namespace is a security boundary rather than presentation: without it a
 * server could declare a tool called `read_file` and silently intercept every
 * call meant for Robin's own. `has()` is what the tool layer uses to decide
 * whether a call belongs to MCP, and it never matches a bare built-in name.
 */
export class McpRegistry {
  private servers: LoadedServer[] = [];
  private readonly createConnection: (config: McpServerConfig) => McpConnectionLike;
  private readonly onError: (serverName: string, message: string) => void;

  constructor(deps: McpRegistryDeps = {}) {
    this.createConnection = deps.createConnection ?? ((config) => new McpConnection(config));
    this.onError = deps.onError ?? (() => {});
  }

  /**
   * Connects each server independently. One that fails contributes no tools
   * and is reported, while every other server still loads — a single bad
   * entry in mcp.json must never cost the user the rest.
   */
  async load(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      const connection = this.createConnection(config);
      try {
        await connection.connect();
        const tools = await connection.listTools();
        this.servers.push({ name: config.name, connection, tools, connected: true });
      } catch (err) {
        // Kept in the list with no tools so closeAll() can still tear down a
        // process that started but failed afterwards.
        this.servers.push({ name: config.name, connection, tools: [], connected: false });
        this.onError(config.name, (err as Error).message);
      }
    }
  }

  toolDefinitions(): ToolDefinition[] {
    return this.servers.flatMap((server) =>
      server.tools.map((tool) => ({
        name: namespacedName(server.name, tool.name),
        // The server name is in the description as well as the name, because
        // the model chooses tools by reading descriptions.
        description: `[via MCP server "${server.name}"] ${tool.description}`,
        parameters: tool.inputSchema,
      }))
    );
  }

  /**
   * Servers that connected, whether or not they contributed tools.
   *
   * Not inferred from the tool list: three servers with one tool each are
   * three, and a connected server exposing none is still running. A server
   * that failed to start is not counted, though it stays in the list so
   * closeAll can reap its process.
   */
  serverCount(): number {
    return this.servers.filter((server) => server.connected).length;
  }

  /** True only for a namespaced name this registry actually serves. */
  has(name: string): boolean {
    const split = splitNamespaced(name);
    if (!split) return false;
    return this.servers.some(
      (server) => server.name === split.server && server.tools.some((t) => t.name === split.tool)
    );
  }

  /**
   * Invokes a tool. Failures come back as text rather than throwing, for the
   * same reason McpConnection.callTool does it: the model can read an error
   * and adapt, where an exception would abort the turn.
   */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const split = splitNamespaced(name);
    const server = split && this.servers.find((s) => s.name === split.server);
    if (!split || !server || !server.tools.some((t) => t.name === split.tool)) {
      return `Error: unknown MCP tool "${name}" — it is not available in this session.`;
    }
    try {
      return await server.connection.callTool(split.tool, args);
    } catch (err) {
      return `Error: MCP server "${split.server}" failed to run "${split.tool}" — ${(err as Error).message}`;
    }
  }

  async closeAll(): Promise<void> {
    const servers = this.servers.splice(0);
    await Promise.all(servers.map((server) => server.connection.close()));
  }
}
