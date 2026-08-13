import { randomBytes } from 'node:crypto';
import { GatewayServer } from './server.js';
import { SessionService } from './session-service.js';
import { ApprovalRegistry } from './approvals.js';
import {
  defaultGatewayInfoPath,
  defaultPort,
  removeGatewayInfo,
  writeGatewayInfo,
} from './discovery.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { listProviders } from '../providers/index.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { ContextLimitStore } from '../providers/context-limits.js';
import { MemoryStore } from '../memory/store.js';
import { SkillStore } from '../skills/store.js';

export interface StartedGateway {
  port: number;
  token: string;
  stop(): Promise<void>;
}

export interface StartGatewayOptions {
  port?: number;
  infoPath?: string;
  log?: (line: string) => void;
}

/**
 * Builds the daemon and starts it listening.
 *
 * The three pieces refer to each other: the server broadcasts approvals the
 * registry raises, the registry answers turns the service runs, and the service
 * emits events the server delivers. The cycle is resolved here, in one
 * function, so no module has to import another merely to be constructed.
 */
export async function startGateway(
  options: StartGatewayOptions = {}
): Promise<StartedGateway> {
  const log = options.log ?? ((line: string) => console.log(line));
  const infoPath = options.infoPath ?? defaultGatewayInfoPath();
  // 32 bytes because anything that can read this token can open the socket,
  // and anything that can open the socket can run commands as this user.
  const token = randomBytes(32).toString('hex');

  let server: GatewayServer;

  const approvals = new ApprovalRegistry({
    broadcast: (pending) => server.broadcastApproval(pending),
    resolved: (pending, approved, by) => server.resolvedApproval(pending, approved, by),
  });

  const sessions = new SessionService({
    providers: listProviders(),
    approvals,
    emit: (sessionId, event) => server.emit(sessionId, event),
    stores: {
      unsupported: new UnsupportedModelStore(),
      contextLimits: new ContextLimitStore(),
      memory: new MemoryStore(),
      skills: new SkillStore(),
    },
  });

  server = new GatewayServer({
    sessions,
    approvals,
    token,
    port: options.port ?? defaultPort(),
    log,
  });

  const port = await server.listen();
  await writeGatewayInfo({ port, pid: process.pid, token, protocol: PROTOCOL_VERSION }, infoPath);
  log(`Robin gateway listening on 127.0.0.1:${port}`);

  return {
    port,
    token,
    async stop(): Promise<void> {
      await server.close();
      // Leaving the file behind would point the next client at a dead port.
      await removeGatewayInfo(infoPath);
    },
  };
}
