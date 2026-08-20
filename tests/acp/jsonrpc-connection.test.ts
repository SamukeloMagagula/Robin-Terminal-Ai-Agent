import { describe, it, expect, vi } from 'vitest';
import { JsonRpcConnection } from '../../src/acp/jsonrpc-connection';
import type { AcpTransport } from '../../src/acp/transport';

function fakeTransport() {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  const sent: Record<string, unknown>[] = [];
  const transport: AcpTransport = {
    onMessage: (h) => {
      handler = h;
    },
    send: (msg) => sent.push(msg),
    onClose: (h) => {
      closeHandler = h;
    },
    close: () => {},
  };
  return {
    transport,
    sent,
    deliver: (msg: Record<string, unknown>) => handler?.(msg),
    triggerClose: () => closeHandler?.(),
  };
}

describe('JsonRpcConnection — handling inbound requests', () => {
  it('dispatches a registered method and sends its result back with the same id', async () => {
    const { transport, sent, deliver } = fakeTransport();
    const conn = new JsonRpcConnection(transport);
    conn.onRequest('initialize', async () => ({ protocolVersion: 1 }));

    deliver({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual([{ jsonrpc: '2.0', id: 7, result: { protocolVersion: 1 } }]);
  });

  it('sends an error response when the handler rejects', async () => {
    const { transport, sent, deliver } = fakeTransport();
    const conn = new JsonRpcConnection(transport);
    conn.onRequest('session/new', async () => {
      throw new Error('no provider configured');
    });

    deliver({ jsonrpc: '2.0', id: 3, method: 'session/new', params: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'no provider configured' } },
    ]);
  });

  it('sends a method-not-found error for an unregistered method', async () => {
    const { transport, sent, deliver } = fakeTransport();
    const conn = new JsonRpcConnection(transport);

    deliver({ jsonrpc: '2.0', id: 1, method: 'nope', params: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: nope' } },
    ]);
  });
});

describe('JsonRpcConnection — handling inbound notifications', () => {
  it('dispatches a registered notification handler with no response sent', async () => {
    const { transport, sent, deliver } = fakeTransport();
    const conn = new JsonRpcConnection(transport);
    const handler = vi.fn();
    conn.onNotification('session/cancel', handler);

    deliver({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'abc' } });
    await new Promise((r) => setTimeout(r, 10));

    expect(handler).toHaveBeenCalledWith({ sessionId: 'abc' });
    expect(sent).toEqual([]);
  });
});

describe('JsonRpcConnection — sending outbound requests', () => {
  it('resolves sendRequest when a matching response arrives', async () => {
    const { transport, sent, deliver } = fakeTransport();
    const conn = new JsonRpcConnection(transport);

    const promise = conn.sendRequest('session/request_permission', { sessionId: 'x' });
    expect(sent).toHaveLength(1);
    const sentId = sent[0].id;

    deliver({ jsonrpc: '2.0', id: sentId, result: { outcome: 'approved' } });

    await expect(promise).resolves.toEqual({ outcome: 'approved' });
  });

  it('rejects sendRequest when an error response arrives', async () => {
    const { transport, sent, deliver } = fakeTransport();
    const conn = new JsonRpcConnection(transport);

    const promise = conn.sendRequest('session/request_permission', {});
    const sentId = sent[0].id;

    deliver({ jsonrpc: '2.0', id: sentId, error: { code: -1, message: 'declined' } });

    await expect(promise).rejects.toThrow('declined');
  });

  it('rejects a pending sendRequest when the transport closes, instead of hanging forever', async () => {
    const { transport, triggerClose } = fakeTransport();
    const conn = new JsonRpcConnection(transport);

    const promise = conn.sendRequest('session/request_permission', {});
    triggerClose();

    await expect(promise).rejects.toThrow(/closed/i);
  });

  it('sendNotification writes a notification with no id', () => {
    const { transport, sent } = fakeTransport();
    const conn = new JsonRpcConnection(transport);

    conn.sendNotification('session/update', { sessionId: 'x' });

    expect(sent).toEqual([{ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'x' } }]);
  });
});
