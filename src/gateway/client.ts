import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  parseFrame,
  type ClientKind,
  type GatewayEvent,
  type SessionSnapshot,
} from './protocol.js';

export interface GatewayClientOptions {
  port: number;
  token: string;
  kind: ClientKind;
  /** Whether this client can put an approval in front of a human. */
  canApprove: boolean;
  cwd: string;
}

export type GatewayEventHandler = (
  sessionId: number | undefined,
  event: GatewayEvent
) => void;

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * A connection to the gateway.
 *
 * Requests are matched to responses by id, because events and responses share
 * one socket and arrive interleaved — a turn's text streams in while a
 * `session.update` is still outstanding.
 */
export class GatewayClient {
  private readonly waiting = new Map<string, Waiting>();
  private readonly handlers = new Set<GatewayEventHandler>();
  private readonly closeHandlers: (() => void)[] = [];
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly sessions: SessionSnapshot[],
    /** What the daemon has, for a client that wants to display it. */
    readonly mcp: { servers: number; tools: number }
  ) {
    socket.on('message', (data) => this.receive(String(data)));
    socket.on('close', () => this.onSocketClosed());
    // An error is always followed by a close. Letting it reach the process as
    // an unhandled 'error' event would take the REPL down instead of printing
    // something a person can act on.
    socket.on('error', () => {});
  }

  static async connect(options: GatewayClientOptions): Promise<GatewayClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${options.port}`);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', (err: Error) =>
        reject(new Error(`Could not reach the gateway on port ${options.port}: ${err.message}`))
      );
    });

    const id = randomUUID();
    const hello = await new Promise<{
      sessions: SessionSnapshot[];
      mcp?: { servers: number; tools: number };
    }>((resolve, reject) => {
      socket.once('message', (data) => {
        const frame = parseFrame(String(data));
        if (!frame || frame.type !== 'res' || frame.id !== id) {
          reject(new Error('The gateway answered the handshake with something unexpected.'));
          return;
        }
        if (!frame.ok) {
          reject(new Error(frame.error.message));
          return;
        }
        resolve(frame.result as { sessions: SessionSnapshot[] });
      });
      socket.send(
        JSON.stringify({
          type: 'req',
          id,
          method: 'connect',
          params: {
            token: options.token,
            kind: options.kind,
            canApprove: options.canApprove,
            cwd: options.cwd,
            protocol: PROTOCOL_VERSION,
          },
        })
      );
    }).catch((err: Error) => {
      socket.close();
      throw err;
    });

    return new GatewayClient(socket, hello.sessions, hello.mcp ?? { servers: 0, tools: 0 });
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The gateway connection is closed.'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  /** Subscribes to events. Returns the unsubscribe. */
  on(handler: GatewayEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }

  private receive(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) return;

    if (frame.type === 'event') {
      for (const handler of this.handlers) handler(frame.sessionId, frame.event);
      return;
    }
    if (frame.type !== 'res') return;

    const waiting = this.waiting.get(frame.id);
    if (!waiting) return;
    this.waiting.delete(frame.id);
    if (frame.ok) waiting.resolve(frame.result);
    else waiting.reject(new Error(frame.error.message));
  }

  private onSocketClosed(): void {
    this.closed = true;
    // A request with nobody left to answer it must fail, not hang: a REPL
    // awaiting session.update would otherwise sit at a dead prompt for good.
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    for (const waiting of pending) {
      waiting.reject(new Error('The gateway connection closed before this finished.'));
    }
    for (const handler of this.closeHandlers) handler();
  }
}
