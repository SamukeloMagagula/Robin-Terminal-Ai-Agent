import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { GatewayServer } from '../../src/gateway/server';
import { PROTOCOL_VERSION, parseFrame, type Frame } from '../../src/gateway/protocol';

/** Minimal hand-rolled client — the real one arrives in Task 8. */
function open(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function next(socket: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      const frame = parseFrame(String(data));
      if (frame) resolve(frame);
      else reject(new Error(`unparseable: ${String(data)}`));
    });
  });
}

function send(socket: WebSocket, frame: unknown): void {
  socket.send(JSON.stringify(frame));
}

const connectParams = {
  token: 'right-token',
  kind: 'terminal',
  canApprove: true,
  cwd: '.',
  protocol: PROTOCOL_VERSION,
};

const sessions = {
  list: vi.fn(),
  create: vi.fn(),
  attach: vi.fn(),
  update: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
  snapshot: vi.fn(),
  sendPrompt: vi.fn(),
  interrupt: vi.fn(),
  history: vi.fn(),
  setHistory: vi.fn(),
  append: vi.fn(),
  personality: vi.fn(),
};
const approvals = { answer: vi.fn() };
const providers = [
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue(['gpt-4o']),
  },
];

let server: GatewayServer;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  sessions.list.mockReturnValue([]);
  approvals.answer.mockReturnValue(true);
  server = new GatewayServer({
    sessions: sessions as never,
    approvals: approvals as never,
    token: 'right-token',
    // Ephemeral: a fixed port makes parallel test files fight each other.
    port: 0,
    log: () => {},
    buildId: 'server-build',
    providers: providers as never,
  });
  port = await server.listen();
});

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await server.close();
});

async function connected(overrides: Record<string, unknown> = {}): Promise<WebSocket> {
  const socket = await open(port);
  openSockets.push(socket);
  send(socket, {
    type: 'req',
    id: 'c',
    method: 'connect',
    params: { ...connectParams, ...overrides },
  });
  await next(socket);
  return socket;
}

async function attached(socket: WebSocket, id: number): Promise<void> {
  sessions.attach.mockReturnValue({ snapshot: { id }, history: [] });
  send(socket, { type: 'req', id: `a${id}`, method: 'session.attach', params: { id } });
  await next(socket);
}

describe('GatewayServer handshake', () => {
  it('answers a good connect with the session list', async () => {
    sessions.list.mockReturnValue([{ id: 1 }]);
    const socket = await open(port);
    openSockets.push(socket);
    send(socket, { type: 'req', id: '1', method: 'connect', params: connectParams });

    const frame = await next(socket);

    expect(frame).toMatchObject({ type: 'res', id: '1', ok: true });
    expect((frame as { result: { sessions: unknown[] } }).result.sessions).toEqual([{ id: 1 }]);
  });

  it('refuses a wrong token and closes the socket', async () => {
    const socket = await open(port);
    openSockets.push(socket);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    send(socket, {
      type: 'req',
      id: '1',
      method: 'connect',
      params: { ...connectParams, token: 'wrong' },
    });

    const frame = await next(socket);

    expect((frame as { error: { code: string } }).error.code).toBe('unauthorized');
    await closed;
  });

  // Auto-start means a stale daemon outlives a rebuild. This is the message
  // that turns a baffling failure into an obvious one.
  it('refuses a protocol version it does not speak, naming the fix', async () => {
    const socket = await open(port);
    openSockets.push(socket);
    send(socket, {
      type: 'req',
      id: '1',
      method: 'connect',
      params: { ...connectParams, protocol: PROTOCOL_VERSION + 1 },
    });

    const frame = await next(socket);

    const error = (frame as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('protocol-mismatch');
    expect(error.message).toContain('robin gateway stop');
  });

  it('refuses any method before connect', async () => {
    const socket = await open(port);
    openSockets.push(socket);
    send(socket, { type: 'req', id: '1', method: 'session.list', params: {} });

    const frame = await next(socket);

    expect((frame as { error: { code: string } }).error.code).toBe('not-connected');
    expect(sessions.list).not.toHaveBeenCalled();
  });

  it('drops a socket that sends something unparseable', async () => {
    const socket = await open(port);
    openSockets.push(socket);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    socket.send('not a frame at all');

    await closed;
  });
});

describe('GatewayServer methods', () => {
  it('routes a call through to the session service', async () => {
    sessions.create.mockReturnValue({ id: 7 });
    const socket = await connected();

    send(socket, {
      type: 'req',
      id: '2',
      method: 'session.create',
      params: { providerId: 'copilot', model: 'gpt-4o', cwd: 'C:/work' },
    });
    const frame = await next(socket);

    // The origin comes from the connect frame, not from the request: a client
    // cannot claim to be a kind it already said it was not.
    expect(sessions.create).toHaveBeenCalledWith({
      providerId: 'copilot',
      model: 'gpt-4o',
      cwd: 'C:/work',
      origin: 'terminal',
    });
    expect(frame).toMatchObject({ type: 'res', id: '2', ok: true, result: { id: 7 } });
  });

  it('turns a thrown error into a failed response, not a dropped socket', async () => {
    sessions.attach.mockImplementation(() => {
      throw new Error('No session 42.');
    });
    const socket = await connected();

    send(socket, { type: 'req', id: '3', method: 'session.attach', params: { id: 42 } });
    const frame = await next(socket);

    expect((frame as { error: { message: string } }).error.message).toContain('42');
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects an unknown method', async () => {
    const socket = await connected();

    send(socket, { type: 'req', id: '4', method: 'nonsense', params: {} });
    const frame = await next(socket);

    expect((frame as { error: { code: string } }).error.code).toBe('unknown-method');
  });

  it('marks a prompt from a terminal as coming from the terminal', async () => {
    sessions.sendPrompt.mockReturnValue({ turnId: 't', queuePosition: 0 });
    const socket = await connected();

    send(socket, { type: 'req', id: '5', method: 'prompt.send', params: { id: 1, text: 'hi' } });
    await next(socket);

    expect(sessions.sendPrompt).toHaveBeenCalledWith(1, 'hi', { surface: 'terminal', who: undefined });
  });

  // A channel client names its own surface and sender, so the approval box can
  // say who is asking. A terminal cannot claim to be Telegram.
  it('takes the surface from a channel client but never from a terminal', async () => {
    sessions.sendPrompt.mockReturnValue({ turnId: 't', queuePosition: 0 });
    const channel = await connected({ kind: 'channel', canApprove: false });

    send(channel, {
      type: 'req',
      id: '6',
      method: 'prompt.send',
      params: { id: 1, text: 'hi', surface: 'telegram', who: '@sam' },
    });
    await next(channel);

    expect(sessions.sendPrompt).toHaveBeenCalledWith(1, 'hi', {
      surface: 'telegram',
      who: '@sam',
    });

    const terminal = await connected();
    send(terminal, {
      type: 'req',
      id: '7',
      method: 'prompt.send',
      params: { id: 1, text: 'hi', surface: 'telegram', who: '@someone-else' },
    });
    await next(terminal);

    expect(sessions.sendPrompt).toHaveBeenLastCalledWith(1, 'hi', {
      surface: 'terminal',
      who: undefined,
    });
  });

  it('routes approval.answer to the registry', async () => {
    const socket = await connected();

    send(socket, {
      type: 'req',
      id: '8',
      method: 'approval.answer',
      params: { approvalId: 'ap-1', approved: true },
    });
    await next(socket);

    // A client that says nothing about scope means this once.
    expect(approvals.answer).toHaveBeenCalledWith('ap-1', true, expect.any(String), 'once');
  });

  it('interrupts a turn', async () => {
    sessions.interrupt.mockReturnValue(true);
    const socket = await connected();

    send(socket, { type: 'req', id: '9', method: 'turn.interrupt', params: { turnId: 't1' } });
    const frame = await next(socket);

    expect(sessions.interrupt).toHaveBeenCalledWith('t1');
    expect(frame).toMatchObject({ ok: true, result: { interrupted: true } });
  });
});

describe('GatewayServer events', () => {
  it('delivers a session event to clients attached to that session', async () => {
    const socket = await connected();
    await attached(socket, 1);
    const received = next(socket);

    server.emit(1, { kind: 'text', turnId: 't', delta: 'hello' });

    expect(await received).toMatchObject({
      type: 'event',
      sessionId: 1,
      event: { kind: 'text', delta: 'hello' },
    });
  });

  it("does not deliver another session's events", async () => {
    const socket = await connected();
    await attached(socket, 1);
    const seen: Frame[] = [];
    socket.on('message', (data) => {
      const frame = parseFrame(String(data));
      if (frame) seen.push(frame);
    });

    server.emit(2, { kind: 'text', turnId: 't', delta: 'not yours' });
    server.emit(1, { kind: 'text', turnId: 't', delta: 'yours' });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ sessionId: 1 });
  });

  it('delivers one session\'s events to every client attached to it', async () => {
    const first = await connected();
    const second = await connected();
    await attached(first, 1);
    await attached(second, 1);
    const both = [next(first), next(second)];

    server.emit(1, { kind: 'text', turnId: 't', delta: 'shared' });

    for (const received of await Promise.all(both)) {
      expect(received).toMatchObject({ event: { delta: 'shared' } });
    }
  });

  it('stops delivering after a client closes the session', async () => {
    const socket = await connected();
    await attached(socket, 1);
    const seen: Frame[] = [];
    socket.on('message', (data) => {
      const frame = parseFrame(String(data));
      if (frame) seen.push(frame);
    });

    send(socket, { type: 'req', id: 'x', method: 'session.close', params: { id: 1 } });
    await vi.waitFor(() => expect(seen).toHaveLength(1)); // the response
    server.emit(1, { kind: 'text', turnId: 't', delta: 'gone' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen).toHaveLength(1);
  });

  it('counts only clients that can approve when broadcasting an approval', async () => {
    await connected({ canApprove: true });
    await connected({ canApprove: false });

    const count = server.broadcastApproval({
      id: 'ap-1',
      sessionId: 1,
      request: { kind: 'run_command', message: 'Run "ls"?' },
      origin: { surface: 'telegram', who: '@sam' },
    });

    expect(count).toBe(1);
  });

  // An approval goes to anyone who can answer it, attached or not: the whole
  // point is that a turn driven from Telegram reaches a keyboard.
  it('offers an approval to an approver that never attached to the session', async () => {
    const approver = await connected({ canApprove: true });
    const received = next(approver);

    server.broadcastApproval({
      id: 'ap-2',
      sessionId: 99,
      request: { kind: 'run_command', message: 'Run "ls"?' },
      origin: { surface: 'telegram', who: '@sam' },
    });

    expect(await received).toMatchObject({
      event: { kind: 'approval.request', approvalId: 'ap-2', origin: { surface: 'telegram' } },
    });
  });

  it('tells approvers when an approval is settled', async () => {
    const approver = await connected({ canApprove: true });
    const received = next(approver);

    server.resolvedApproval(
      {
        id: 'ap-3',
        sessionId: 1,
        request: { kind: 'run_command', message: 'Run "ls"?' },
        origin: { surface: 'terminal' },
      },
      true,
      'someone-else'
    );

    expect(await received).toMatchObject({
      event: { kind: 'approval.resolved', approvalId: 'ap-3', approved: true },
    });
  });

  // A channel client cannot approve anything, but it raised the turn and has
  // to be able to tell its user what happened to the tool call.
  it('tells a non-approving client attached to the session that an approval settled', async () => {
    const channel = await connected({ kind: 'channel', canApprove: false });
    await attached(channel, 1);
    const received = next(channel);

    server.resolvedApproval(
      {
        id: 'ap-5',
        sessionId: 1,
        request: { kind: 'run_command', message: 'Run "ls"?' },
        origin: { surface: 'telegram' },
      },
      false,
      'nobody attached'
    );

    expect(await received).toMatchObject({
      event: { kind: 'approval.resolved', approvalId: 'ap-5', approved: false },
    });
  });

  it('does not tell a client with no stake in that session', async () => {
    const bystander = await connected({ kind: 'channel', canApprove: false });
    const seen: Frame[] = [];
    bystander.on('message', (data) => {
      const frame = parseFrame(String(data));
      if (frame) seen.push(frame);
    });

    server.resolvedApproval(
      {
        id: 'ap-6',
        sessionId: 77,
        request: { kind: 'run_command', message: 'Run "ls"?' },
        origin: { surface: 'terminal' },
      },
      true,
      'someone'
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen).toEqual([]);
  });

  it('does not count a client that has gone away', async () => {
    const socket = await connected({ canApprove: true });
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
    // The server learns of the close asynchronously.
    await vi.waitFor(() => {
      expect(
        server.broadcastApproval({
          id: 'ap-4',
          sessionId: 1,
          request: { kind: 'run_command', message: 'Run "ls"?' },
          origin: { surface: 'terminal' },
        })
      ).toBe(0);
    });
  });
});

describe('GatewayServer and browser origins', () => {
  function connectFrom(origin?: string): Promise<{ opened: boolean }> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: origin ? { origin } : {},
      });
      socket.once('open', () => {
        socket.close();
        resolve({ opened: true });
      });
      socket.once('error', () => resolve({ opened: false }));
      socket.once('unexpected-response', () => resolve({ opened: false }));
    });
  }

  // WebSockets are not subject to CORS, so any page you visit can open a
  // socket to a loopback port. The token still guards it, but a browser is
  // exactly the client that can be tricked into spending one it already holds.
  it('refuses an upgrade from a web page', async () => {
    expect((await connectFrom('https://evil.example')).opened).toBe(false);
  });

  it('allows a client that sends no origin, which is every non-browser one', async () => {
    expect((await connectFrom()).opened).toBe(true);
  });

  it('allows the control UI, served from this very port', async () => {
    expect((await connectFrom(`http://127.0.0.1:${port}`)).opened).toBe(true);
  });

  it('allows localhost by name as well as by address', async () => {
    expect((await connectFrom(`http://localhost:${port}`)).opened).toBe(true);
  });
});

describe('GatewayServer and stale builds', () => {
  async function connectWithBuild(build?: string): Promise<Record<string, unknown>> {
    const socket = await open(port);
    openSockets.push(socket);
    send(socket, {
      type: 'req',
      id: 'c',
      method: 'connect',
      params: { ...connectParams, build },
    });
    const frame = await next(socket);
    return (frame as { result: Record<string, unknown> }).result;
  }

  // The protocol version refuses a client that cannot be understood. This is
  // the softer, far more common case: same protocol, different code — a daemon
  // still running yesterday's build, behaving like yesterday's build without
  // saying so.
  it('reports a build that does not match its own', async () => {
    const result = await connectWithBuild('deadbeef0000');
    expect(result.staleBuild).toBe(true);
    expect(result.build).toBe('server-build');
  });

  it('says nothing is stale when the builds agree', async () => {
    const result = await connectWithBuild('server-build');
    expect(result.staleBuild).toBe(false);
  });

  // A client that cannot work out its own build must not be told it is stale:
  // "unknown" and "different" are not the same answer.
  it('does not call an unknown build stale', async () => {
    const result = await connectWithBuild(undefined);
    expect(result.staleBuild).toBe(false);
  });

  it('still lets a stale client work, because most rebuilds change nothing', async () => {
    const socket = await open(port);
    openSockets.push(socket);
    send(socket, {
      type: 'req',
      id: 'c',
      method: 'connect',
      params: { ...connectParams, build: 'deadbeef0000' },
    });
    await next(socket);

    send(socket, { type: 'req', id: '2', method: 'session.list', params: {} });
    expect(await next(socket)).toMatchObject({ ok: true });
  });
});

describe('GatewayServer approval scopes', () => {
  it.each([
    ['session', 'session'],
    ['reply', 'reply'],
    ['once', 'once'],
    ['nonsense', 'once'],
    [undefined, 'once'],
  ])('passes scope %s through as %s', async (sent, expected) => {
    const socket = await connected();

    send(socket, {
      type: 'req',
      id: 's',
      method: 'approval.answer',
      params: { approvalId: 'ap-1', approved: true, scope: sent },
    });
    await next(socket);

    expect(approvals.answer).toHaveBeenCalledWith('ap-1', true, expect.any(String), expected);
  });
});

describe('GatewayServer provider methods', () => {
  // The browser cannot read ~/.robin/auth.json, so it has to ask what it can
  // use before it can offer to start a conversation.
  it('lists providers with whether they are usable', async () => {
    const socket = await connected();

    send(socket, { type: 'req', id: 'p', method: 'providers.list', params: {} });
    const frame = await next(socket);

    const result = (frame as { result: { providers: { id: string; authenticated: boolean }[] } })
      .result;
    expect(result.providers.map((p) => p.id)).toContain('copilot');
    expect(typeof result.providers[0].authenticated).toBe('boolean');
  });

  it('lists the models of one provider on request', async () => {
    const socket = await connected();

    send(socket, {
      type: 'req',
      id: 'm',
      method: 'providers.models',
      params: { providerId: 'copilot' },
    });
    const frame = await next(socket);

    expect((frame as { result: { models: string[] } }).result.models).toEqual(['gpt-4o']);
  });

  // Model catalogues are a network call per provider; asking for all of them
  // at once would make opening the UI wait on every provider you own.
  it('reports a provider it does not know rather than guessing', async () => {
    const socket = await connected();

    send(socket, {
      type: 'req',
      id: 'm',
      method: 'providers.models',
      params: { providerId: 'nonsense' },
    });
    const frame = await next(socket);

    expect(frame).toMatchObject({ ok: false });
  });
});
