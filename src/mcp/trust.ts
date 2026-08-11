import type { TrustStore } from '../trust-store.js';
import { serverFingerprint, type McpServerConfig } from './config.js';

export type TrustAnswer = 'yes' | 'no' | 'always';

/**
 * Asks about one server entry. Injected so the filter can be tested without a
 * terminal, and so the prompt's wording lives with the rest of the UI.
 */
export type TrustPrompt = (config: McpServerConfig) => Promise<TrustAnswer>;

/**
 * The servers Robin is allowed to launch.
 *
 * An entry in mcp.json is a command Robin will execute — `npx -y some-package`
 * means running it. That earns the same gate PERSONALITY.md gets, for the same
 * reason: config files travel with repositories and get pasted from the
 * internet, and neither is a decision Robin should make silently.
 *
 * `yes` approves this exact entry, so changing the command asks again.
 * `always` approves the server name whatever its command becomes — right for a
 * server you maintain, wrong for one you pasted.
 */
export async function filterTrustedServers(
  servers: McpServerConfig[],
  trustStore: TrustStore,
  prompt: TrustPrompt
): Promise<McpServerConfig[]> {
  const trusted: McpServerConfig[] = [];

  for (const server of servers) {
    const fingerprint = serverFingerprint(server.name, server);
    if (await trustStore.isTrusted('mcp-server', server.name, fingerprint)) {
      trusted.push(server);
      continue;
    }

    const answer = await prompt(server);
    if (answer === 'yes') {
      await trustStore.trustContent('mcp-server', server.name, fingerprint);
      trusted.push(server);
    } else if (answer === 'always') {
      await trustStore.trustKey('mcp-server', server.name);
      trusted.push(server);
    }
    // 'no' — skipped, and not recorded, so it asks again next time.
  }

  return trusted;
}
