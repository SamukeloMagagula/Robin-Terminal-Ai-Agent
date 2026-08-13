import { vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { GatewayServer } from '../../src/gateway/server';
import { GatewayClient } from '../../src/gateway/client';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { Provider } from '../../src/providers/types';
import type { SessionSnapshot } from '../../src/gateway/protocol';

/**
 * A real gateway, in this process, on an ephemeral port.
 *
 * Command handlers are tested through this rather than through a hand-written
 * fake client, because a fake would encode a second copy of the server's
 * dispatch and could drift from it — and a handler that passes against a fake
 * while failing against the daemon is worse than no test.
 */
export interface GatewayHarness {
  client: GatewayClient;
  sessions: SessionService;
  session: SessionSnapshot;
  port: number;
  /** Connects another client to the same gateway — a second terminal, or a channel. */
  connect(options: { kind: 'terminal' | 'channel'; canApprove: boolean }): Promise<GatewayClient>;
  close(): Promise<void>;
}

export function stubProvider(id = 'copilot', name = 'GitHub Copilot'): Provider {
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['gpt-4o']),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'ok' };
    }),
  } as unknown as Provider;
}

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

export async function startHarness(
  options: { providers?: Provider[]; cwd?: string } = {}
): Promise<GatewayHarness> {
  const providers = options.providers ?? [stubProvider()];
  let server: GatewayServer;

  const approvals = new ApprovalRegistry({
    broadcast: (pending) => server.broadcastApproval(pending),
    resolved: (pending, approved, by) => server.resolvedApproval(pending, approved, by),
  });
  const sessions = new SessionService({
    providers,
    approvals,
    emit: (sessionId, event) => server.emit(sessionId, event),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
    },
  });
  server = new GatewayServer({
    sessions,
    approvals,
    token: 'test-token',
    port: 0,
    log: () => {},
  });

  const port = await server.listen();
  const client = await GatewayClient.connect({
    port,
    token: 'test-token',
    kind: 'terminal',
    canApprove: true,
    cwd: options.cwd ?? '.',
  });

  const session = sessions.create({
    providerId: providers[0].id,
    model: 'gpt-4o',
    cwd: options.cwd ?? '.',
  });
  await client.request('session.attach', { id: session.id });

  const extra: GatewayClient[] = [];

  return {
    client,
    sessions,
    session,
    port,
    async connect({ kind, canApprove }): Promise<GatewayClient> {
      const another = await GatewayClient.connect({
        port,
        token: 'test-token',
        kind,
        canApprove,
        cwd: options.cwd ?? '.',
      });
      extra.push(another);
      return another;
    },
    async close(): Promise<void> {
      for (const another of extra) await another.close().catch(() => {});
      await client.close().catch(() => {});
      await server.close();
    },
  };
}
