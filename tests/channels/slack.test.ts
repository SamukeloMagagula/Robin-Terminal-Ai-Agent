import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SlackTransport } from '../../src/channels/slack';
import type { IncomingMessage } from '../../src/channels/types';

class FakeSocket extends EventEmitter {
  readonly sent: unknown[] = [];
  readyState = 1;
  readonly OPEN = 1;

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  deliver(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

/** Slack answers 200 with ok:false for failures, so responses are bodies. */
function api(responses: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const method = String(url).split('/').pop() as string;
    const body = responses[method] ?? { ok: true };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

function transport(responses: Record<string, unknown> = {}) {
  const socket = new FakeSocket();
  const fetchImpl = api({
    'auth.test': { ok: true, user: 'robin' },
    'apps.connections.open': { ok: true, url: 'wss://slack.test/socket' },
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
    'chat.update': { ok: true },
    ...responses,
  });
  const t = new SlackTransport({
    token: 'xoxb-bot',
    appToken: 'xapp-level',
    connectSocket: () => socket as never,
    fetchImpl,
  });
  return { t, socket, fetchImpl };
}

function messageEnvelope(over: Record<string, unknown> = {}) {
  return {
    type: 'events_api',
    envelope_id: 'env-1',
    payload: {
      event: { type: 'message', text: 'hello there', user: 'U1', channel: 'C1', ...over },
    },
  };
}

describe('SlackTransport.connect', () => {
  it('reports the bot identity', async () => {
    const { t } = transport();
    expect(await t.connect()).toEqual({ identity: '@robin' });
  });

  // Slack returns HTTP 200 with ok:false for a bad token, so the status alone
  // would say everything is fine.
  it('fails on ok:false rather than trusting the status', async () => {
    const { t } = transport({ 'auth.test': { ok: false, error: 'invalid_auth' } });
    await expect(t.connect()).rejects.toThrow(/invalid_auth/);
  });
});

describe('SlackTransport.receive', () => {
  async function listening(t: SlackTransport, socket: FakeSocket) {
    const controller = new AbortController();
    const seen: IncomingMessage[] = [];
    void t.receive(async (m) => {
      seen.push(m);
    }, controller.signal);
    // Let apps.connections.open resolve before frames are delivered.
    await new Promise((r) => setTimeout(r, 10));
    return { controller, seen, socket };
  }

  it('delivers a message with its channel and sender', async () => {
    const { t, socket } = transport();
    const { controller, seen } = await listening(t, socket);

    socket.deliver(messageEnvelope());
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]).toMatchObject({ chatId: 'C1', senderId: 'U1', text: 'hello there' });
    controller.abort();
  });

  // Slack re-sends anything unacknowledged, so a missing ack answers the same
  // message twice.
  it('acknowledges every envelope', async () => {
    const { t, socket } = transport();
    const { controller } = await listening(t, socket);

    socket.deliver(messageEnvelope());
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ envelope_id: 'env-1' }));

    controller.abort();
  });

  it('ignores messages from bots, including itself', async () => {
    const { t, socket } = transport();
    const { controller, seen } = await listening(t, socket);

    socket.deliver(messageEnvelope({ bot_id: 'B1' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(seen).toEqual([]);
    controller.abort();
  });

  // An edit, a join, a file share: all carry a subtype and none is someone
  // talking to the bot.
  it('ignores message subtypes', async () => {
    const { t, socket } = transport();
    const { controller, seen } = await listening(t, socket);

    socket.deliver(messageEnvelope({ subtype: 'message_changed' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(seen).toEqual([]);
    controller.abort();
  });

  it('stops when the signal aborts', async () => {
    const { t, socket } = transport();
    const controller = new AbortController();
    const done = t.receive(async () => {}, controller.signal);
    await new Promise((r) => setTimeout(r, 10));

    controller.abort();
    socket.close();

    await expect(done).resolves.toBeUndefined();
  });
});

describe('SlackTransport.send and edit', () => {
  it('posts and returns the timestamp that identifies the message', async () => {
    const { t } = transport();
    expect(await t.send('C1', 'the reply')).toBe('1700000000.000100');
  });

  it('edits by timestamp, which is what Slack uses for an id', async () => {
    const { t, fetchImpl } = transport();

    await t.edit('C1', '1700000000.000100', 'the fuller reply');

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const update = calls.find(([url]) => String(url).endsWith('chat.update'));
    expect(JSON.parse((update?.[1] as { body: string }).body)).toMatchObject({
      channel: 'C1',
      ts: '1700000000.000100',
    });
  });

  it('splits a long reply', async () => {
    const { t, fetchImpl } = transport();

    await t.send('C1', 'x'.repeat(9000));

    const posts = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([url]) => String(url).endsWith('chat.postMessage')
    );
    expect(posts.length).toBeGreaterThan(1);
  });
});
