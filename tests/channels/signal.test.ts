import { describe, it, expect } from 'vitest';
import { SignalTransport } from '../../src/channels/signal';

/**
 * A fetch stand-in that replays queued signal-cli-rest-api responses and
 * records calls. Once the queue is exhausted it aborts `controller`, because
 * receive() polls forever by design — mirrors tests/channels/telegram.test.ts.
 */
function fakeFetch(responses: { status: number; body: unknown }[], controller?: AbortController) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (index >= responses.length) {
      controller?.abort();
      return { status: 200, json: async () => [] } as unknown as Response;
    }
    const next = responses[index++];
    return { status: next.status, json: async () => next.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const opts = { apiUrl: 'http://localhost:8080', phoneNumber: '+15551234567' };

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    envelope: {
      source: '+15559876543',
      sourceName: 'Sam',
      dataMessage: { message: 'hello' },
      ...overrides,
    },
  };
}

describe('SignalTransport.connect', () => {
  it('reports the configured phone number as identity when the container is reachable', async () => {
    const { impl } = fakeFetch([{ status: 200, body: {} }]);
    const transport = new SignalTransport({ ...opts, fetchImpl: impl });
    expect(await transport.connect()).toEqual({ identity: '+15551234567' });
  });

  it('throws when the container is unreachable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const transport = new SignalTransport({ ...opts, fetchImpl: impl });
    await expect(transport.connect()).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws when the container responds with an error status', async () => {
    const { impl } = fakeFetch([{ status: 500, body: { error: 'boom' } }]);
    const transport = new SignalTransport({ ...opts, fetchImpl: impl });
    await expect(transport.connect()).rejects.toThrow(/500/);
  });
});

describe('SignalTransport.receive', () => {
  it('maps a direct message to chatId === senderId === source', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch([{ status: 200, body: [envelope()] }], controller);
    const transport = new SignalTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    const received: unknown[] = [];
    await transport.receive(async (m) => {
      received.push(m);
    }, controller.signal);
    expect(received).toEqual([
      { chatId: '+15559876543', senderId: '+15559876543', senderName: 'Sam', text: 'hello' },
    ]);
  });

  it('maps a group message to chatId === groupId, senderId === source', async () => {
    const controller = new AbortController();
    const groupEnvelope = envelope({ dataMessage: { message: 'hi all', groupInfo: { groupId: 'abc123==' } } });
    const { impl } = fakeFetch([{ status: 200, body: [groupEnvelope] }], controller);
    const transport = new SignalTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    const received: unknown[] = [];
    await transport.receive(async (m) => {
      received.push(m);
    }, controller.signal);
    expect(received).toEqual([
      { chatId: 'abc123==', senderId: '+15559876543', senderName: 'Sam', text: 'hi all' },
    ]);
  });

  it('drops an envelope with no dataMessage.message', async () => {
    const controller = new AbortController();
    const receipt = { envelope: { source: '+15559876543', receiptMessage: {} } };
    const { impl } = fakeFetch([{ status: 200, body: [receipt] }], controller);
    const transport = new SignalTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    const received: unknown[] = [];
    await transport.receive(async (m) => {
      received.push(m);
    }, controller.signal);
    expect(received).toEqual([]);
  });

  it('keeps polling past a fetch rejection instead of exiting', async () => {
    const controller = new AbortController();
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls === 1) throw new Error('network blip');
      if (calls >= 2) controller.abort();
      return { status: 200, json: async () => [] } as unknown as Response;
    }) as unknown as typeof fetch;
    const transport = new SignalTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0, sleep: async () => {} });
    await transport.receive(async () => {}, controller.signal);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('polls again after an empty response', async () => {
    const controller = new AbortController();
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls >= 2) controller.abort();
      return { status: 200, json: async () => [] } as unknown as Response;
    }) as unknown as typeof fetch;
    const transport = new SignalTransport({ ...opts, fetchImpl: impl, pollIntervalMs: 0 });
    await transport.receive(async () => {}, controller.signal);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('SignalTransport.send', () => {
  it('posts the message with the reply in recipients', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { timestamp: 123 } }]);
    const transport = new SignalTransport({ ...opts, fetchImpl: impl });
    await transport.send('+15559876543', 'hi there');
    expect(calls[0].url).toBe('http://localhost:8080/v2/send');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      message: 'hi there',
      number: '+15551234567',
      recipients: ['+15559876543'],
    });
  });

  it('uses the group id, not the phone number, as the recipient for a group reply', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { timestamp: 123 } }]);
    const transport = new SignalTransport({ ...opts, fetchImpl: impl });
    await transport.send('abc123==', 'hi group');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ recipients: ['abc123=='] });
  });
});

describe('SignalTransport shape', () => {
  it('exposes no edit method', () => {
    const transport = new SignalTransport(opts);
    expect('edit' in transport).toBe(false);
  });

  it('has the expected id and name', () => {
    const transport = new SignalTransport(opts);
    expect(transport.id).toBe('signal');
    expect(transport.name).toBe('Signal');
  });
});
