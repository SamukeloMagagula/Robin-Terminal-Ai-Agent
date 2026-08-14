import { TrustStore } from '../trust-store.js';
import { loadMcpConfig, serverFingerprint, type McpServerConfig } from '../mcp/config.js';
import { McpRegistry } from '../mcp/registry.js';

export interface StartMcpDeps {
  trustStore?: TrustStore;
  /** Injectable so the daemon's behaviour can be tested without an mcp.json. */
  loadConfig?: () => Promise<McpServerConfig[]>;
  /** Injectable so tests need not spawn real servers. */
  connect?: (servers: McpServerConfig[]) => Promise<void>;
  log?: (line: string) => void;
}

export interface StartedMcp {
  registry: McpRegistry;
  started: string[];
  /** Configured but not trusted — named so the silence is explainable. */
  skipped: string[];
}

/**
 * Brings up the MCP servers the user has already approved.
 *
 * The daemon never asks. It runs detached with no terminal, and an mcp.json
 * entry is a command Robin will execute — `npx -y some-package` means running
 * it — so a server nobody has agreed to is skipped rather than launched
 * quietly. `robin mcp` is where that approval happens, in a process that has a
 * user attached to answer.
 *
 * Nothing here is allowed to stop the gateway starting: a broken server, an
 * unreadable config or a failed spawn costs the tools that server offered, not
 * the daemon.
 */
export async function startTrustedMcpServers(deps: StartMcpDeps = {}): Promise<StartedMcp> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const trustStore = deps.trustStore ?? new TrustStore();

  const registry = new McpRegistry({
    onError: (server, message) => log(`MCP server "${server}" unavailable — ${message}`),
  });

  let configured: McpServerConfig[];
  try {
    configured = await (deps.loadConfig ?? loadMcpConfig)();
  } catch (err) {
    log(`Could not read mcp.json — ${(err as Error).message}`);
    return { registry, started: [], skipped: [] };
  }
  if (configured.length === 0) return { registry, started: [], skipped: [] };

  const trusted: McpServerConfig[] = [];
  const skipped: string[] = [];
  for (const server of configured) {
    const fingerprint = serverFingerprint(server.name, server);
    if (await trustStore.isTrusted('mcp-server', server.name, fingerprint)) trusted.push(server);
    else skipped.push(server.name);
  }

  if (skipped.length > 0) {
    log(
      `Not starting ${skipped.length} MCP server(s) you have not approved: ${skipped.join(', ')}. ` +
        'Run `robin mcp` to review them.'
    );
  }
  if (trusted.length === 0) return { registry, started: [], skipped };

  try {
    await (deps.connect ?? ((servers) => registry.load(servers)))(trusted);
  } catch (err) {
    log(`MCP servers failed to start — ${(err as Error).message}`);
    return { registry, started: [], skipped };
  }

  return { registry, started: trusted.map((server) => server.name), skipped };
}
