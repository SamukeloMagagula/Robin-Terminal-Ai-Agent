import { randomUUID } from 'node:crypto';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
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
  /**
   * Serves the /v1 routes on the same port. Absent means the port speaks
   * WebSocket only, which is all the tests of this file need.
   */
  http?: { handle(req: IncomingMessage, res: ServerResponse): Promise<void> };
  /** Reported at connect, so a client's HUD can say what the daemon actually has. */
  mcpSummary?: () => { servers: number; tools: number };
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

/** Loopback, by address or by name, on any port. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/**
 * Whether a WebSocket upgrade may proceed.
 *
 * WebSockets are not subject to CORS, so any page you happen to visit can open
 * a socket to a loopback port. The token still guards what can be done with it,
 * but the control UI is a browser client holding that token, and a browser is
 * exactly what can be tricked into spending one it already has.
 *
 * No Origin header means no browser — every Node client, the REPL and the
 * bridge included, sends none, and those are trusted by the token alone.
 */
export function allowedOrigin(info: { origin?: string }): boolean {
  if (!info.origin) return true;
  try {
    return isLoopbackHost(new URL(info.origin).hostname);
  } catch {
    return false;
  }
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
  private http: HttpServer | undefined;
  private readonly clients = new Map<string, Client>();
  private readonly eventListeners = new Set<(sessionId: number, event: GatewayEvent) => void>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: GatewayServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Subscribes to every event the daemon emits.
   *
   * The HTTP API needs the same stream the WebSocket clients get, without
   * being one. Returns the unsubscribe.
   */
  onEvent(handler: (sessionId: number, event: GatewayEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => {
      this.eventListeners.delete(handler);
    };
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      // One port for both protocols: the WebSocket rides on the same HTTP
      // server the /v1 routes are served from, so there is a single address to
      // find, a single token to hold, and one thing to firewall.
      const http = createServer((req, res) => {
        void this.deps.http?.handle(req, res);
      });
      this.http = http;

      const wss = new WebSocketServer({ server: http, verifyClient: allowedOrigin });
      this.wss = wss;
      wss.on('connection', (socket) => this.accept(socket));
      // ws re-emits the HTTP server's errors on itself. Without a listener
      // here, a failed listen — the ordinary case when two clients race to
      // auto-start — is an unhandled 'error' event that takes the process down
      // instead of a rejected promise the caller can act on.
      wss.on('error', () => {});

      // `on`, not `once`: a failed listen can emit more than once, and a second
      // emission with no listener left is an unhandled error that takes the
      // process down instead of the port simply being unavailable.
      let settled = false;
      http.on('error', (err: Error) => {
        if (settled) {
          this.log(`gateway server error: ${err.message}`);
          return;
        }
        settled = true;
        // Nothing is listening, so this server is not going to be closed by
        // the caller — it never got a handle to it.
        http.close(() => {});
        reject(err);
      });
      http.once('listening', () => {
        settled = true;
        const address = http.address();
        resolve(typeof address === 'object' && address ? address.port : this.deps.port);
      });
      // Loopback only. This port can run commands as the user who started it;
      // the token is a second lock, not the first one.
      http.listen(this.deps.port, '127.0.0.1');
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.socket.close();
    this.clients.clear();
    const wss = this.wss;
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      this.wss = undefined;
    }
    const http = this.http;
    if (!http) return;
    await new Promise<void>((resolve) => http.close(() => resolve()));
    this.http = undefined;
  }

  /** Delivers a session's event to every client watching that session. */
  emit(sessionId: number, event: GatewayEvent): void {
    const frame: EventFrame = { type: 'event', sessionId, event };
    for (const client of this.clients.values()) {
      if (client.connected && client.attached.has(sessionId)) this.write(client, frame);
    }
    for (const listener of this.eventListeners) listener(sessionId, event);
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

  /**
   * Tells clients an approval is settled.
   *
   * Wider than the request that raised it: approvers need it to close their
   * box, and everyone attached to the session needs it because what happened
   * to a tool call is part of that conversation's story. The Telegram bridge
   * cannot approve anything, and would otherwise have no way to tell the user
   * their request was refused.
   */
  resolvedApproval(pending: PendingApproval, approved: boolean, by: string): void {
    for (const client of this.clients.values()) {
      if (!client.connected) continue;
      if (!client.canApprove && !client.attached.has(pending.sessionId)) continue;
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
      return {
        sessions: this.deps.sessions.list(),
        protocol: PROTOCOL_VERSION,
        mcp: this.deps.mcpSummary?.() ?? { servers: 0, tools: 0 },
      };
    }

    if (!client.connected) throw coded('not-connected', 'Send connect first.');

    switch (frame.method) {
      case 'session.list':
        return { sessions: this.deps.sessions.list() };
      case 'session.create':
        return this.deps.sessions.create({
          ...(params as unknown as Parameters<SessionService['create']>[0]),
          // A client cannot claim to be a kind it is not: the connect frame
          // already said what it was, and that is what counts here.
          origin:
            params.origin === 'http' && client.kind === 'terminal'
              ? 'http'
              : client.kind === 'channel'
                ? 'channel'
                : 'terminal',
        });
      case 'session.attach': {
        const id = Number(params.id);
        const result = this.deps.sessions.attach(id);
        // Only after attach succeeds: subscribing to a session that does not
        // exist would deliver events for whatever later claimed that id.
        client.attached.add(id);
        return result;
      }
      case 'session.detach':
        // Unsubscribes without touching the session: a terminal that has moved
        // to another conversation should stop receiving this one's events.
        client.attached.delete(Number(params.id));
        return {};
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
      case 'session.snapshot':
        return this.deps.sessions.snapshot(Number(params.id));
      case 'session.history':
        return {
          history: this.deps.sessions.history(Number(params.id)),
          personality: this.deps.sessions.personality(Number(params.id)),
        };
      case 'session.setHistory':
        return this.deps.sessions.setHistory(
          Number(params.id),
          (params.messages ?? []) as never
        );
      case 'session.append':
        this.deps.sessions.append(Number(params.id), params.message as never);
        return {};
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
