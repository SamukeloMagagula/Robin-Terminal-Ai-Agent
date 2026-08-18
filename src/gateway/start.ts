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
import { SessionStore } from './session-store.js';
import { AutonomyStore } from '../autonomy/grant-store.js';
import { AuditLog } from '../autonomy/audit.js';
import { ScheduleStore } from '../schedule/store.js';
import { Scheduler } from '../schedule/scheduler.js';
import { createJobRunner } from '../schedule/run-job.js';
import { deliverToChannel } from '../schedule/deliver.js';
import { SettingsStore } from '../settings/store.js';
import { createHttpApi } from './http-api.js';
import { startTrustedMcpServers } from './mcp.js';
import { buildFingerprint, freshBuildFingerprint } from './build-id.js';

export interface StartedGateway {
  port: number;
  token: string;
  stop(): Promise<void>;
}

export interface StartGatewayOptions {
  port?: number;
  infoPath?: string;
  log?: (line: string) => void;
  /**
   * Where conversations are persisted. Overridable so a test never restores —
   * or overwrites — the real ones sitting in the user's home directory.
   */
  sessionsDir?: string;
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
  const buildId = await buildFingerprint();

  let server: GatewayServer;

  const approvals = new ApprovalRegistry({
    broadcast: (pending) => server.broadcastApproval(pending),
    resolved: (pending, approved, by) => server.resolvedApproval(pending, approved, by),
  });

  // Held rather than constructed inline: shutdown has to flush it, because a
  // governed session's decisions are appended without being awaited.
  const audit = new AuditLog();

  // Before the service, because a session created on the first connect should
  // already be able to see the MCP tools.
  const mcp = await startTrustedMcpServers({ log });

  const sessions = new SessionService({
    providers: listProviders(),
    approvals,
    mcp: mcp.registry,
    emit: (sessionId, event) => server.emit(sessionId, event),
    stores: {
      unsupported: new UnsupportedModelStore(),
      contextLimits: new ContextLimitStore(),
      memory: new MemoryStore(),
      skills: new SkillStore(),
      sessions: new SessionStore(options.sessionsDir),
      // One store and one log for the whole daemon. The audit log serialises
      // its appends internally, and that only orders what a single instance
      // is given — a second one would interleave with the first.
      autonomy: new AutonomyStore(),
      audit,
    },
  });

  // The gateway is the only long-lived process Robin has, so it is where a
  // timer belongs. Jobs are prompts it sends itself.
  const scheduler = new Scheduler({
    store: new ScheduleStore(),
    runJob: createJobRunner({
      sessions,
      // A job with no provider of its own uses the one `robin setup` chose.
      defaults: async () => {
        const settings = new SettingsStore();
        return {
          providerId: String(await settings.get('default.provider')),
          model: String(await settings.get('default.model')),
        };
      },
      cwd: process.cwd(),
    }),
    deliver: deliverToChannel,
    log,
  });

  // Before the port opens: a client that connects must never see an empty
  // session list that is about to fill in.
  await sessions.restore();
  const restored = sessions.list().length;

  server = new GatewayServer({
    sessions,
    approvals,
    token,
    port: options.port ?? defaultPort(),
    log,
    buildId,
    isStale: async () => {
      if (!buildId) return false;
      const onDisk = await freshBuildFingerprint();
      return onDisk !== undefined && onDisk !== buildId;
    },
    providers: listProviders(),
    mcpSummary: () => ({
      servers: mcp.started.length,
      tools: mcp.registry.toolDefinitions().length,
    }),
    http: createHttpApi({
      token,
      providers: listProviders(),
      sessions,
      subscribe: (handler) => server.onEvent(handler),
    }),
  });

  // After restore, so a job cannot fire into a half-built session list, and
  // before the port opens, so it is already ticking by the time anyone asks.
  const jobs = await new ScheduleStore().list();
  scheduler.start();

  const port = await server.listen();
  await writeGatewayInfo(
    { port, pid: process.pid, token, protocol: PROTOCOL_VERSION, build: buildId },
    infoPath
  );
  const notes = [
    restored > 0 ? `${restored} conversation(s) restored` : undefined,
    jobs.filter((job) => job.enabled).length > 0
      ? `${jobs.filter((job) => job.enabled).length} scheduled job(s)`
      : undefined,
    // Counted from the tools, not the servers: a server that was launched but
    // never answered would otherwise be announced as though it had worked.
    mcp.registry.toolDefinitions().length > 0
      ? `${mcp.registry.toolDefinitions().length} MCP tool(s)`
      : undefined,
  ].filter(Boolean);
  log(
    `Robin gateway listening on 127.0.0.1:${port}` +
      (notes.length > 0 ? ` — ${notes.join(', ')}` : '')
  );

  return {
    port,
    token,
    async stop(): Promise<void> {
      await server.close();
      // Each server is a child process the daemon started; leaving them behind
      // would outlive the thing that spawned them.
      await mcp.registry.closeAll();
      // Belt-and-braces only: conversations are written as they happen,
      // precisely because on Windows this never runs.
      scheduler.stop();
      await sessions.flush();
      // What an unattended session did is exactly the record worth not losing.
      await audit.flush();
      // Leaving the file behind would point the next client at a dead port.
      await removeGatewayInfo(infoPath);
    },
  };
}
