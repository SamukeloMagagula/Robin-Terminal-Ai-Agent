import { describe, it, expect } from 'vitest';
import { TelegramTransport, chunkMessage, TELEGRAM_MAX_MESSAGE } from '../../src/channels/telegram';
import type { IncomingMessage } from '../../src/channels/types';

/**
 * A fetch stand-in that replays queued Telegram responses and records calls.
 *
 * Once the queue is exhausted it aborts `controller`, because receive() polls
 * forever by design — without a stop condition the loop would spin until the
 * test worker ran out of memory rather than failing with a useful message.
 */
function fakeFetch(responses: unknown[], controller?: AbortController) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let index = 0;
  const impl = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop() ?? '';
    calls.push({ method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (index >= responses.length) controller?.abort();
    const next = index < responses.length ? responses[index++] : { ok: true, result: [] };
    return {
      status: 200,
      json: async () => next,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (result: unknown) => ({ ok: true, result });

function update(id: number, text: string, from = 42, chat = 99) {
  return {
    update_id: id,
    message: { message_id: id, text, chat: { id: chat }, from: { id: from, username: 'sam' } },
  };
}

describe('chunkMessage', () => {
  it('leaves a short message as a single chunk', () => {
    expect(chunkMessage('hello')).toEqual(['hello']);
  });

  it('splits a long message into chunks within the limit', () => {
    const chunks = chunkMessage('x'.repeat(TELEGRAM_MAX_MESSAGE * 2 + 100));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
  });

  it('prefers to break at a paragraph boundary', () => {
    const first = 'a'.repeat(60);
    const second = 'b'.repeat(60);
    const chunks = chunkMessage(`${first}\n\n${second}`, 100);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });

  it('hard-splits rather than emitting a nearly empty chunk', () => {
    // The only newline sits in the first 20%, so breaking there would waste
    // most of the chunk.
    const chunks = chunkMessage(`ab\n${'c'.repeat(200)}`, 100);
    expect(chunks[0].length).toBe(100);
  });

  it('loses no content across the split', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    expect(chunkMessage(text, 200).join('\n')).toBe(text);
  });
});

describe('TelegramTransport.connect', () => {
  it('reports the bot username', async () => {
    const { impl } = fakeFetch([ok({ username: 'robin_bot' })]);
    const transport = new TelegramTransport({ token: 't', fetchImpl: impl });
    expect(await transport.connect()).toEqual({ identity: '@robin_bot' });
  });

  it('surfaces Telegram’s own description when the token is wrong', async () => {
    const { impl } = fakeFetch([{ ok: false, description: 'Unauthorized' }]);
    const transport = new TelegramTransport({ token: 'bad', fetchImpl: impl });
    await expect(transport.connect()).rejects.toThrow(/Unauthorized/);
  });
});

describe('TelegramTransport.send', () => {
  it('sends a short reply as one message', async () => {
    const { impl, calls } = fakeFetch([ok({})]);
    await new TelegramTransport({ token: 't', fetchImpl: impl }).send('99', 'hi');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'sendMessage', body: { chat_id: '99', text: 'hi' } });
  });

  it('splits an over-long reply across several messages', async () => {
    const { impl, calls } = fakeFetch([ok({}), ok({}), ok({})]);
    await new TelegramTransport({ token: 't', fetchImpl: impl }).send(
      '99',
      'x'.repeat(TELEGRAM_MAX_MESSAGE + 10)
    );
    expect(calls.length).toBeGreaterThan(1);
  });

  it('never sets parse_mode, so unbalanced markdown cannot drop the reply', async () => {
    const { impl, calls } = fakeFetch([ok({})]);
    await new TelegramTransport({ token: 't', fetchImpl: impl }).send('99', 'a * b _ c');
    expect(calls[0].body.parse_mode).toBeUndefined();
  });
});

describe('TelegramTransport.receive', () => {
  it('drains the backlog before polling, so old messages are not acted on', async () => {
    const controller = new AbortController();
    const { impl, calls } = fakeFetch(
      [
        ok([update(10, 'stale')]), // backlog drain
        ok([]), // first real poll, returns nothing
      ],
      controller
    );
    const seen: IncomingMessage[] = [];

    const transport = new TelegramTransport({ token: 't', fetchImpl: impl });
    await transport.receive(async (m) => {
      seen.push(m);
    }, controller.signal);

    expect(seen).toHaveLength(0);
    expect(calls[0].body.offset).toBe(-1);
    // The poll that follows must resume past the drained update.
    expect(calls[1].body.offset).toBe(11);
  });

  it('delivers a new message and advances the offset past it', async () => {
    const controller = new AbortController();
    const { impl, calls } = fakeFetch(
      [ok([]) /* empty backlog */, ok([update(5, 'hello')])],
      controller
    );
    const seen: IncomingMessage[] = [];

    const transport = new TelegramTransport({ token: 't', fetchImpl: impl });
    await transport.receive(async (m) => {
      seen.push(m);
    }, controller.signal);

    expect(seen).toEqual([{ chatId: '99', senderId: '42', senderName: 'sam', text: 'hello' }]);
    // The poll after the delivered update must not ask for it again.
    expect(calls.at(-1)?.body.offset).toBe(6);
  });

  it('keeps polling after a handler throws', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(
      [ok([]), ok([update(1, 'boom'), update(2, 'fine')])],
      controller
    );
    const seen: string[] = [];

    const transport = new TelegramTransport({ token: 't', fetchImpl: impl });
    await transport.receive(async (m) => {
      seen.push(m.text);
      if (m.text === 'boom') throw new Error('handler exploded');
    }, controller.signal);

    expect(seen).toEqual(['boom', 'fine']);
  });

  it('backs off and retries after a failed poll rather than exiting', async () => {
    const controller = new AbortController();
    let slept = 0;
    const { impl } = fakeFetch(
      [ok([]), { ok: false, description: 'Bad Gateway' }, ok([update(3, 'recovered')])],
      controller
    );
    const seen: string[] = [];

    const transport = new TelegramTransport({
      token: 't',
      fetchImpl: impl,
      sleep: async () => {
        slept += 1;
      },
    });
    await transport.receive(async (m) => {
      seen.push(m.text);
    }, controller.signal);

    expect(slept).toBe(1);
    expect(seen).toEqual(['recovered']);
  });

  it('ignores updates with no text, such as photos and joins', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(
      [
        ok([]),
        ok([{ update_id: 1, message: { message_id: 1, chat: { id: 9 }, from: { id: 42 } } }]),
        ok([update(2, 'text')]),
      ],
      controller
    );
    const seen: string[] = [];

    const transport = new TelegramTransport({ token: 't', fetchImpl: impl });
    await transport.receive(async (m) => {
      seen.push(m.text);
    }, controller.signal);

    expect(seen).toEqual(['text']);
  });
});
