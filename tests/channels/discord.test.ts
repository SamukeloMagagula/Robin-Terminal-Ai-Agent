import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DiscordTransport, DISCORD_MAX_MESSAGE } from '../../src/channels/discord';
import type { IncomingMessage } from '../../src/channels/types';

/** A stand-in for the gateway socket, driven from the test. */
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

  /** Pushes a gateway frame at the transport. */
  deliver(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

function transport(options: { fetchImpl?: typeof fetch } = {}) {
  const socket = new FakeSocket();
  const t = new DiscordTransport({
    token: 'bot-token',
    connectSocket: () => socket as never,
    fetchImpl:
      options.fetchImpl ??
      (vi.fn().mockResolvedValue({ ok: true, json: async () => ({ username: 'robin' }) }) as never),
  });
  return { t, socket };
}

describe('DiscordTransport.connect', () => {
  it('reports the bot identity from the API', async () => {
    const { t } = transport();
    expect(await t.connect()).toEqual({ identity: '@robin' });
  });

  // The gateway reports a bad token by closing with an opaque code, which is a
  // poor thing to hand an operator.
  it('says plainly when the token is rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never;
    const { t } = transport({ fetchImpl });

    await expect(t.connect()).rejects.toThrow(/token/i);
  });

  it('reports another failure with its status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as never;
    const { t } = transport({ fetchImpl });

    await expect(t.connect()).rejects.toThrow(/503/);
  });
});

describe('DiscordTransport.receive', () => {
  function hello(socket: FakeSocket): void {
    socket.deliver({ op: 10, d: { heartbeat_interval: 45000 } });
  }

  function messageCreate(socket: FakeSocket, over: Record<string, unknown> = {}): void {
    socket.deliver({
      op: 0,
      s: 1,
      t: 'MESSAGE_CREATE',
      d: {
        channel_id: 'c1',
        content: 'hello there',
        author: { id: 'u1', username: 'sam', bot: false },
        ...over,
      },
    });
  }

  it('identifies itself once the gateway says hello', async () => {
    const { t, socket } = transport();
    const controller = new AbortController();
    void t.receive(async () => {}, controller.signal);
    await Promise.resolve();

    hello(socket);

    const identify = socket.sent.find((f) => (f as { op: number }).op === 2) as {
      d: { token: string; intents: number };
    };
    expect(identify.d.token).toBe('bot-token');
    // MESSAGE_CONTENT is privileged; without it every message arrives empty.
    expect(identify.d.intents & (1 << 15)).toBeTruthy();
    controller.abort();
  });

  it('delivers a message with its channel and sender', async () => {
    const { t, socket } = transport();
    const controller = new AbortController();
    const seen: IncomingMessage[] = [];
    void t.receive(async (m) => {
      seen.push(m);
    }, controller.signal);
    await Promise.resolve();
    hello(socket);

    messageCreate(socket);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]).toEqual({
      chatId: 'c1',
      senderId: 'u1',
      senderName: 'sam',
      text: 'hello there',
    });
    controller.abort();
  });

  // Without this the bot answers its own reply, and then that reply, forever.
  it('ignores messages from bots, including itself', async () => {
    const { t, socket } = transport();
    const controller = new AbortController();
    const seen: IncomingMessage[] = [];
    void t.receive(async (m) => {
      seen.push(m);
    }, controller.signal);
    await Promise.resolve();
    hello(socket);

    messageCreate(socket, { author: { id: 'self', username: 'robin', bot: true } });
    await new Promise((r) => setTimeout(r, 30));

    expect(seen).toEqual([]);
    controller.abort();
  });

  it('ignores an empty message, which is what a missing content intent looks like', async () => {
    const { t, socket } = transport();
    const controller = new AbortController();
    const seen: IncomingMessage[] = [];
    void t.receive(async (m) => {
      seen.push(m);
    }, controller.signal);
    await Promise.resolve();
    hello(socket);

    messageCreate(socket, { content: '' });
    await new Promise((r) => setTimeout(r, 30));

    expect(seen).toEqual([]);
    controller.abort();
  });

  it('ignores gateway frames that are not messages', async () => {
    const { t, socket } = transport();
    const controller = new AbortController();
    const seen: IncomingMessage[] = [];
    void t.receive(async (m) => {
      seen.push(m);
    }, controller.signal);
    await Promise.resolve();
    hello(socket);

    socket.deliver({ op: 0, s: 2, t: 'PRESENCE_UPDATE', d: {} });
    socket.deliver({ op: 11 });
    socket.deliver('not json at all');
    await new Promise((r) => setTimeout(r, 30));

    expect(seen).toEqual([]);
    controller.abort();
  });

  it('stops when the signal aborts rather than reconnecting for ever', async () => {
    const { t, socket } = transport();
    const controller = new AbortController();
    const done = t.receive(async () => {}, controller.signal);
    await Promise.resolve();
    hello(socket);

    controller.abort();

    await expect(done).resolves.toBeUndefined();
  });
});

describe('DiscordTransport.send', () => {
  it('posts to the channel', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
    const { t } = transport({ fetchImpl });

    await t.send('c1', 'the reply');

    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(String(url)).toContain('/channels/c1/messages');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ content: 'the reply' });
  });

  // Discord rejects anything over 2000 characters outright.
  it('splits a long reply rather than having it rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
    const { t } = transport({ fetchImpl });

    await t.send('c1', 'x'.repeat(DISCORD_MAX_MESSAGE * 2 + 10));

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [, init] of calls) {
      const body = JSON.parse((init as { body: string }).body) as { content: string };
      expect(body.content.length).toBeLessThanOrEqual(2000);
    }
  });
});
