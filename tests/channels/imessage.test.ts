import { describe, it, expect } from 'vitest';
import { IMessageTransport } from '../../src/channels/imessage';

/**
 * A fetch stand-in that replays queued BlueBubbles responses and records
 * calls. Once the queue is exhausted it aborts `controller`, because
 * receive() polls forever by design — mirrors tests/channels/signal.test.ts.
 */
function fakeFetch(responses: { status: number; body: unknown }[], controller?: AbortController) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (index >= responses.length) {
      controller?.abort();
      return { status: 200, json: async () => ({ data: [] }) } as unknown as Response;
    }
    const next = responses[index++];
    return { status: next.status, json: async () => next.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const opts = { apiUrl: 'http://localhost:1234', password: 'sekret' };

function message(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'msg-1',
    text: 'hello',
    dateCreated: 1000,
    isFromMe: false,
    handle: { address: '+15559876543' },
    chats: [{ guid: 'iMessage;-;+15559876543' }],
    ...overrides,
  };
}

const pong = { status: 200, message: 'pong' };
const emptySeed = { data: [] }; // no prior messages — cursor seeds to Date.now()

describe('IMessageTransport.connect', () => {
  it('reports the configured apiUrl as identity when the server is reachable', async () => {
    const { impl } = fakeFetch([{ status: 200, body: pong }]);
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl });
    expect(await transport.connect()).toEqual({ identity: 'http://localhost:1234' });
  });

  it('throws when the server is unreachable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl });
    await expect(transport.connect()).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws when the server responds with an error status', async () => {
    const { impl } = fakeFetch([{ status: 401, body: { error: 'bad password' } }]);
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl });
    await expect(transport.connect()).rejects.toThrow(/401/);
  });
});

describe('IMessageTransport.receive', () => {
  it('seeds the cursor from the latest existing message and never delivers it', async () => {
    const controller = new AbortController();
    const seed = { data: [message({ dateCreated: 5000 })] };
    const { impl } = fakeFetch([{ status: 200, body: seed }], controller);
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    const received: unknown[] = [];
    await transport.receive(async (m) => {
      received.push(m);
    }, controller.signal);
    expect(received).toEqual([]);
  });

  it('maps a queried message to chatId from chats[0].guid and senderId from handle.address', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(
      [{ status: 200, body: emptySeed }, { status: 200, body: { data: [message()] } }],
      controller
    );
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    const received: unknown[] = [];
    await transport.receive(async (m) => {
      received.push(m);
    }, controller.signal);
    expect(received).toEqual([
      { chatId: 'iMessage;-;+15559876543', senderId: '+15559876543', senderName: undefined, text: 'hello' },
    ]);
  });

  it('drops a message with isFromMe: true', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(
      [{ status: 200, body: emptySeed }, { status: 200, body: { data: [message({ isFromMe: true })] } }],
      controller
    );
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    const received: unknown[] = [];
    await transport.receive(async (m) => {
      received.push(m);
    }, controller.signal);
    expect(received).toEqual([]);
  });

  it('drops a message with no text', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(
      [{ status: 200, body: emptySeed }, { status: 200, body: { data: [message({ text: null })] } }],
      controller
    );
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    const received: unknown[] = [];
    await transport.receive(async (m) => {
      received.push(m);
    }, controller.signal);
    expect(received).toEqual([]);
  });

  it('advances the cursor past a dropped message so it is not re-fetched', async () => {
    const controller = new AbortController();
    // Seeded with a low dateCreated so it doesn't fall back to Date.now(),
    // which would dwarf the small fixture timestamps used here.
    const seed = { data: [message({ dateCreated: 500 })] };
    const dropped = message({ isFromMe: true, dateCreated: 9000 });
    const { impl, calls } = fakeFetch(
      [{ status: 200, body: seed }, { status: 200, body: { data: [dropped] } }],
      controller
    );
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    await transport.receive(async () => {}, controller.signal);

    // calls[0] = seed, calls[1] = first poll (returns the dropped message),
    // calls[2] = second poll — its body must reflect the dropped message's timestamp.
    const thirdCallBody = JSON.parse(String(calls[2].init?.body));
    expect(thirdCallBody.after).toBe(9000);
  });

  it('keeps polling past a handler error instead of exiting', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(
      [{ status: 200, body: emptySeed }, { status: 200, body: { data: [message()] } }],
      controller
    );
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    let calls = 0;
    await transport.receive(async () => {
      calls++;
      throw new Error('handler boom');
    }, controller.signal);
    expect(calls).toBe(1);
  });

  it('keeps polling past a fetch rejection instead of exiting', async () => {
    const controller = new AbortController();
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls === 1) return { status: 200, json: async () => emptySeed } as unknown as Response;
      if (calls === 2) throw new Error('network blip');
      controller.abort();
      return { status: 200, json: async () => ({ data: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0, sleep: async () => {} });
    await transport.receive(async () => {}, controller.signal);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe('IMessageTransport.send', () => {
  it('posts chatGuid and message, and returns the created guid', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { data: { guid: 'new-msg-guid' } } }]);
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl });
    const id = await transport.send('iMessage;-;+15559876543', 'hi there');
    expect(calls[0].url).toBe('http://localhost:1234/api/v1/message/text?password=sekret');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      chatGuid: 'iMessage;-;+15559876543',
      message: 'hi there',
    });
    expect(id).toBe('new-msg-guid');
  });

  it('returns undefined when the response carries no guid', async () => {
    const { impl } = fakeFetch([{ status: 200, body: {} }]);
    const transport = new IMessageTransport({ ...opts, fetchImpl: impl });
    expect(await transport.send('chat-1', 'hi')).toBeUndefined();
  });
});

describe('IMessageTransport shape', () => {
  it('exposes no edit method', () => {
    const transport = new IMessageTransport(opts);
    expect('edit' in transport).toBe(false);
  });

  it('has the expected id and name', () => {
    const transport = new IMessageTransport(opts);
    expect(transport.id).toBe('imessage');
    expect(transport.name).toBe('iMessage');
  });
});
