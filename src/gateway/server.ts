import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseFrame,
  type ClientKind,
  type EventFrame,
  type GatewayEvent,
  type RequestFrame,
  type ResponseFrame,
} from './protocol.js';
import type { SessionService } from './session-service.js';
import type { ApprovalRegistry, PendingApproval } from './approvals.js';

export interface GatewayServerDeps {
  sessions: SessionService;
  approvals: ApprovalRegistry;
  token: string;
  port: number;
  log?: (line: string) => void;
}

interface Client {
  id: string;
  socket: WebSocket;
  connected: boolean;
  kind: ClientKind;
  canApprove: boolean;
  cwd: string;
  attached: Set<number>;
}

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * The socket half.
 *
 * Translates frames into SessionService calls and events into frames, and does
 * nothing else — every decision worth testing lives behind it in
 * session-service.ts and approvals.ts.
 */
export class GatewayServer {
  private wss: WebSocketServer | undefined;
  private readonly clients = new Map<string, Client>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: GatewayServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Loopback only. This socket can run commands as the user who started
      // it; the token is a second lock, not the first one.
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.deps.port });
      this.wss = wss;
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.removeListener('error', reject);
        const address = wss.address();
        resolve(typeof address === 'object' && address ? address.port : this.deps.port);
      });
      wss.on('connection', (socket) => this.accept(socket));
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.socket.close();
    this.clients.clear();
    const wss = this.wss;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.wss = undefined;
  }

  /** Delivers a session's event to every client watching that session. */
  emit(sessionId: number, event: GatewayEvent): void {
    const frame: EventFrame = { type: 'event', sessionId, event };
    for (const client of this.clients.values()) {
      if (client.connected && client.attached.has(sessionId)) this.write(client, frame);
    }
  }

  /**
   * Offers an approval to every client that can answer one, attached or not.
   *
   * Not scoped to the session on purpose: the whole point is that a turn
   * driven from Telegram reaches a keyboard, and the keyboard may be looking
   * at a different conversation.
   */
  broadcastApproval(pending: PendingApproval): number {
    let offered = 0;
    for (const client of this.clients.values()) {
      if (!client.connected || !client.canApprove) continue;
      this.write(client, {
        type: 'event',
        sessionId: pending.sessionId,
        event: {
          kind: 'approval.request',
          approvalId: pending.id,
          request: pending.request,
          origin: pending.origin,
        },
      });
      offered += 1;
    }
    return offered;
  }

  resolvedApproval(pending: PendingApproval, approved: boolean, by: string): void {
    for (const client of this.clients.values()) {
      if (!client.connected || !client.canApprove) continue;
      this.write(client, {
        type: 'event',
        sessionId: pending.sessionId,
        event: { kind: 'approval.resolved', approvalId: pending.id, approved, by },
      });
    }
  }

  private accept(socket: WebSocket): void {
    const client: Client = {
      id: randomUUID(),
      socket,
      connected: false,
      kind: 'terminal',
      canApprove: false,
      cwd: process.cwd(),
      attached: new Set(),
    };
    this.clients.set(client.id, client);

    socket.on('message', (data) => {
      const frame = parseFrame(String(data));
      // Anything can be on the other end of a socket. A frame that does not
      // parse is not a conversation worth continuing.
      if (!frame || frame.type !== 'req') {
        socket.close();
        return;
      }
      void this.dispatch(client, frame);
    });

    socket.on('close', () => {
      this.clients.delete(client.id);
    });

    // An error is always followed by a close. Letting it reach the process as
    // an unhandled 'error' event would take the daemon down over one bad peer.
    socket.on('error', (err: Error) => this.log(`client error: ${err.message}`));
  }

  private async dispatch(client: Client, frame: RequestFrame): Promise<void> {
    try {
      const result = await this.handle(client, frame);
      this.write(client, { type: 'res', id: frame.id, ok: true, result });
    } catch (err) {
      const error = err as Error & { code?: string };
      this.write(client, {
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: error.code ?? 'error', message: error.message },
      });
      // A bad token or a mismatched protocol is not a recoverable request; it
      // is a client that should not be talking to this daemon at all.
      if (error.code === 'unauthorized' || error.code === 'protocol-mismatch') {
        client.socket.close();
      }
    }
  }

  private async handle(client: Client, frame: RequestFrame): Promise<unknown> {
    const params = frame.params;

    if (frame.method === 'connect') {
      if (params.token !== this.deps.token) throw coded('unauthorized', 'Bad gateway token.');
      if (params.protocol !== PROTOCOL_VERSION) {
        throw coded(
          'protocol-mismatch',
          `This gateway speaks protocol ${PROTOCOL_VERSION}, the client speaks ${String(params.protocol)}. ` +
            'Run `robin gateway stop` and try again — an old daemon is still running.'
        );
      }
      client.connected = true;
      client.kind = params.kind === 'channel' ? 'channel' : 'terminal';
      client.canApprove = params.canApprove === true;
      if (typeof params.cwd === 'string') client.cwd = params.cwd;
      return { sessions: this.deps.sessions.list(), protocol: PROTOCOL_VERSION };
    }

    if (!client.connected) throw coded('not-connected', 'Send connect first.');

    switch (frame.method) {
      case 'session.list':
        return { sessions: this.deps.sessions.list() };
      case 'session.create':
        return this.deps.sessions.create(params as never);
      case 'session.attach': {
        const id = Number(params.id);
        const result = this.deps.sessions.attach(id);
        // Only after attach succeeds: subscribing to a session that does not
        // exist would deliver events for whatever later claimed that id.
        client.attached.add(id);
        return result;
      }
      case 'session.close': {
        const id = Number(params.id);
        this.deps.sessions.close(id);
        client.attached.delete(id);
        return {};
      }
      case 'session.update':
        return this.deps.sessions.update(Number(params.id), params.patch as never);
      case 'session.clear':
        return this.deps.sessions.clear(Number(params.id));
      case 'prompt.send':
        return this.deps.sessions.sendPrompt(Number(params.id), String(params.text), {
          // A terminal is a terminal. Only a channel client may name its own
          // surface and sender, and only for the approval box to display —
          // nothing downstream makes a decision on it.
          surface:
            client.kind === 'channel' ? String(params.surface ?? 'channel') : 'terminal',
          who:
            client.kind === 'channel' && typeof params.who === 'string' ? params.who : undefined,
        });
      case 'turn.interrupt':
        return { interrupted: this.deps.sessions.interrupt(String(params.turnId)) };
      case 'approval.answer':
        return {
          accepted: this.deps.approvals.answer(
            String(params.approvalId),
            params.approved === true,
            client.id
          ),
        };
      default:
        throw coded('unknown-method', `Unknown method "${frame.method}".`);
    }
  }

  private write(client: Client, frame: ResponseFrame | EventFrame): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.socket.send(JSON.stringify(frame));
  }
}
