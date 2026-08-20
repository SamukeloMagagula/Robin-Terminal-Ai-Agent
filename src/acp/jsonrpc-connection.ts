import { randomUUID } from 'node:crypto';
import { isRequest, isNotification, isResponse } from './jsonrpc.js';
import type { AcpTransport } from './transport.js';

/**
 * Request/id bookkeeping for a genuinely bidirectional JSON-RPC stream.
 *
 * ACP is not a client/server pair with fixed roles: the editor sends requests
 * Robin must answer (initialize, session/new, session/prompt), and Robin
 * sends requests the editor must answer (session/request_permission). Both
 * directions need "send a request, get a promise back keyed by id" and
 * "receive a request, dispatch to a handler, send the response" — this class
 * handles both over the one transport.
 */
export class JsonRpcConnection {
  private readonly requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  private readonly notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
  private readonly waiting = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(private readonly transport: AcpTransport) {
    transport.onMessage((msg) => this.receive(msg));
    // Without this, a request awaiting an answer that can now never arrive —
    // most importantly session/request_permission — hangs forever instead of
    // failing when the editor exits or its end of the pipe goes away.
    transport.onClose(() => this.handleTransportClosed());
  }

  private handleTransportClosed(): void {
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    for (const entry of pending) {
      entry.reject(new Error('The connection closed before this finished.'));
    }
  }

  onRequest(method: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  sendRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  sendNotification(method: string, params: Record<string, unknown> = {}): void {
    this.transport.send({ jsonrpc: '2.0', method, params });
  }

  private async receive(msg: Record<string, unknown>): Promise<void> {
    if (isResponse(msg)) {
      const waiting = this.waiting.get(msg.id);
      if (!waiting) return;
      this.waiting.delete(msg.id);
      if ('error' in msg) {
        const err = msg.error as { code: number; message: string };
        waiting.reject(new Error(err.message));
      } else {
        waiting.resolve(msg.result);
      }
      return;
    }

    if (isNotification(msg)) {
      this.notificationHandlers.get(msg.method)?.((msg.params ?? {}) as Record<string, unknown>);
      return;
    }

    if (isRequest(msg)) {
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) {
        this.transport.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
        return;
      }
      try {
        const result = await handler((msg.params ?? {}) as Record<string, unknown>);
        this.transport.send({ jsonrpc: '2.0', id: msg.id, result });
      } catch (err) {
        this.transport.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
}
