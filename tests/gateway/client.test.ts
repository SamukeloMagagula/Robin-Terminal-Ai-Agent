import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayServer } from '../../src/gateway/server';
import { GatewayClient } from '../../src/gateway/client';
import type { GatewayEvent } from '../../src/gateway/protocol';

const sessions = {
  list: vi.fn(),
  attach: vi.fn(),
  sendPrompt: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
  snapshot: vi.fn(),
  interrupt: vi.fn(),
};
const approvals = { answer: vi.fn() };

let server: GatewayServer;
let port: number;
const clients: GatewayClient[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  sessions.list.mockReturnValue([{ id: 1, model: 'gpt-4o' }]);
  sessions.attach.mockReturnValue({ snapshot: { id: 1 }, history: [] });
  sessions.sendPrompt.mockReturnValue({ turnId: 't1', queuePosition: 0 });
  approvals.answer.mockReturnValue(true);
  server = new GatewayServer({
    sessions: sessions as never,
    approvals: approvals as never,
    token: 'tok',
    port: 0,
    log: () => {},
  });
  port = await server.listen();
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server.close();
});

async function connect(canApprove = true): Promise<GatewayClient> {
  const client = await GatewayClient.connect({
    port,
    token: 'tok',
    kind: 'terminal',
    canApprove,
    cwd: '.',
  });
  clients.push(client);
  return client;
}

describe('GatewayClient', () => {
  it('connects and reports the sessions the gateway already has', async () => {
    const client = await connect();
    expect(client.sessions).toEqual([{ id: 1, model: 'gpt-4o' }]);
  });

  it('fails to connect with a bad token', async () => {
    await expect(
      GatewayClient.connect({ port, token: 'wrong', kind: 'terminal', canApprove: true, cwd: '.' })
    ).rejects.toThrow(/token/i);
  });

  it('fails to connect when nothing is listening, naming the port', async () => {
    await expect(
      GatewayClient.connect({ port: 1, token: 'tok', kind: 'terminal', canApprove: true, cwd: '.' })
    ).rejects.toThrow(/1/);
  });

  it('matches responses to their requests', async () => {
    const client = await connect();
    const result = await client.request<{ turnId: string }>('prompt.send', { id: 1, text: 'hi' });
    expect(result.turnId).toBe('t1');
  });

  // Responses and events share one socket and arrive interleaved: a turn's
  // text streams in while a session.update is still outstanding.
  it('matches the right response when several are in flight', async () => {
    const client = await connect();
    sessions.list.mockReturnValue([{ id: 'from-list' }]);
    sessions.snapshot.mockReturnValue({ id: 'from-snapshot' });

    const [list, prompt] = await Promise.all([
      client.request<{ sessions: unknown[] }>('session.list'),
      client.request<{ turnId: string }>('prompt.send', { id: 1, text: 'hi' }),
    ]);

    expect(list.sessions).toEqual([{ id: 'from-list' }]);
    expect(prompt.turnId).toBe('t1');
  });

  it('rejects the request that failed, not the connection', async () => {
    sessions.attach.mockImplementation(() => {
      throw new Error('No session 42.');
    });
    const client = await connect();

    await expect(client.request('session.attach', { id: 42 })).rejects.toThrow('No session 42.');

    sessions.list.mockReturnValue([]);
    await expect(client.request('session.list')).resolves.toBeDefined();
  });

  it('delivers events to a handler', async () => {
    const client = await connect();
    await client.request('session.attach', { id: 1 });
    const seen: GatewayEvent[] = [];
    client.on((_sessionId, event) => seen.push(event));

    server.emit(1, { kind: 'text', turnId: 't1', delta: 'hello' });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ kind: 'text', delta: 'hello' });
  });

  it('tells the handler which session an event belongs to', async () => {
    const client = await connect();
    await client.request('session.attach', { id: 1 });
    const seen: (number | undefined)[] = [];
    client.on((sessionId) => seen.push(sessionId));

    server.emit(1, { kind: 'text', turnId: 't1', delta: 'hello' });

    await vi.waitFor(() => expect(seen).toEqual([1]));
  });

  it('stops delivering to an unsubscribed handler', async () => {
    const client = await connect();
    await client.request('session.attach', { id: 1 });
    const seen: GatewayEvent[] = [];
    const off = client.on((_sessionId, event) => seen.push(event));
    off();

    server.emit(1, { kind: 'text', turnId: 't1', delta: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen).toEqual([]);
  });

  it('tells the caller when the gateway goes away mid-session', async () => {
    const client = await connect();
    const closed = vi.fn();
    client.onClose(closed);

    await server.close();

    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  });

  // A REPL awaiting session.update would otherwise sit at a dead prompt for
  // good.
  it('rejects in-flight requests when the socket closes rather than hanging', async () => {
    const client = await connect();
    sessions.list.mockImplementation(() => new Promise(() => {}) as never);

    const inflight = client.request('session.list');
    await server.close();

    await expect(inflight).rejects.toThrow(/gateway/i);
  });

  it('refuses to send on a closed connection instead of hanging', async () => {
    const client = await connect();
    await client.close();

    await expect(client.request('session.list')).rejects.toThrow(/closed/i);
  });
});
