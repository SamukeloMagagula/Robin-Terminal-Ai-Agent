/**
 * `robin acp` — speaks the Agent Client Protocol on stdin/stdout, for editors
 * like Zed and JetBrains that spawn Robin as their agent subprocess.
 *
 * A bridge process, structurally identical to `serve-command.ts`'s chat
 * platform bridges: connects to the gateway as a `kind: 'terminal'` client
 * and translates its own wire protocol (newline-delimited JSON-RPC on
 * stdio) into GatewayClient calls, instead of a chat platform's API.
 *
 * See docs/superpowers/specs/2026-08-20-acp-editor-integration-design.md.
 */

import { ensureGateway } from '../gateway/ensure.js';
import { GatewayClient } from '../gateway/client.js';
import { createStdioTransport } from '../acp/transport.js';
import { JsonRpcConnection } from '../acp/jsonrpc-connection.js';
import { AcpBridge } from '../acp/bridge.js';
import { storedChatDefault } from '../settings/defaults.js';
import { SettingsStore } from '../settings/store.js';
import { listProviders } from '../providers/index.js';
import { UserFacingError } from '../startup/bootstrap.js';

export async function runAcp(): Promise<void> {
  const info = await ensureGateway();
  const client = await GatewayClient.connect({
    port: info.port,
    token: info.token,
    kind: 'terminal',
    canApprove: true,
    cwd: process.cwd(),
  });

  const transport = createStdioTransport();
  const connection = new JsonRpcConnection(transport);
  new AcpBridge(connection, {
    client,
    resolveDefault: async () => {
      // No TTY here for an interactive picker the way startChat()'s fallback
      // has one — failing clearly is the only option, not a silent guess.
      const stored = await storedChatDefault(new SettingsStore(), listProviders());
      if (!stored) {
        throw new UserFacingError(
          'No default provider/model set. Run `robin setup` first, then reconnect the editor.'
        );
      }
      return { providerId: stored.provider.id, model: stored.model };
    },
  });

  // The editor closing the pipe is how an ACP session ends.
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await client.close().catch(() => {});
}
