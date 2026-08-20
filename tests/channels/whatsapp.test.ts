import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { WhatsAppTransport, type WhatsAppOptions } from '../../src/channels/whatsapp';
import type { IncomingMessage } from '../../src/channels/types';

const opts = {
  token: 'wa-token',
  phoneNumberId: '109876543210987',
  verifyToken: 'my-verify-token',
  appSecret: 'my-app-secret',
  webhookPort: 0,
  bindHost: '127.0.0.1',
};

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function request(
  port: number,
  init: { method: string; path: string; body?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: init.method, path: init.path, headers: init.headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** Builds a transport and starts receive(), returning the bound port once the listener is up. */
async function startTransport(
  options: WhatsAppOptions,
  handler: (m: IncomingMessage) => Promise<void> = async () => {}
): Promise<{ transport: WhatsAppTransport; port: number; controller: AbortController; done: Promise<void> }> {
  const controller = new AbortController();
  let resolvePort!: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => (resolvePort = resolve));
  const transport = new WhatsAppTransport({ ...options, onListening: resolvePort });
  const done = transport.receive(handler, controller.signal);
  const port = await portPromise;
  return { transport, port, controller, done };
}

function textPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '15559876543', profile: { name: 'Sam' } }],
              messages: [{ from: '15559876543', type: 'text', text: { body: 'hello' } }],
              ...overrides,
            },
          },
        ],
      },
    ],
  });
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
});

describe('WhatsAppTransport.connect', () => {
  it('reports the display phone number as identity', async () => {
    const fetchImpl = (async () =>
      ({ status: 200, json: async () => ({ display_phone_number: '+1 555 123 4567' }) }) as unknown as Response) as unknown as typeof fetch;
    const transport = new WhatsAppTransport({ ...opts, fetchImpl });
    expect(await transport.connect()).toEqual({ identity: '+1 555 123 4567' });
  });

  it('throws with the API error detail on failure', async () => {
    const fetchImpl = (async () =>
      ({
        status: 401,
        json: async () => ({ error: { message: 'Invalid OAuth access token' } }),
      }) as unknown as Response) as unknown as typeof fetch;
    const transport = new WhatsAppTransport({ ...opts, fetchImpl });
    await expect(transport.connect()).rejects.toThrow(/Invalid OAuth access token/);
  });
});

describe('WhatsAppTransport.receive — webhook verification', () => {
  it('echoes the challenge back when the verify token matches', async () => {
    const { transport, port, controller, done } = await startTransport(opts);
    cleanup = async () => {
      controller.abort();
      await done;
    };

    const res = await request(port, {
      method: 'GET',
      path: `/?hub.mode=subscribe&hub.verify_token=${opts.verifyToken}&hub.challenge=abc123`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('abc123');
  });

  it('refuses with 403 when the verify token is wrong', async () => {
    const { transport, port, controller, done } = await startTransport(opts);
    cleanup = async () => {
      controller.abort();
      await done;
    };

    const res = await request(port, {
      method: 'GET',
      path: `/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`,
    });
    expect(res.status).toBe(403);
  });
});

describe('WhatsAppTransport.receive — signature verification', () => {
  it('accepts a correctly signed message and delivers it to the handler', async () => {
    const received: IncomingMessage[] = [];
    const { transport, port, controller, done } = await startTransport(opts, async (m) => {
      received.push(m);
    });
    cleanup = async () => {
      controller.abort();
      await done;
    };

    const body = textPayload();
    const res = await request(port, {
      method: 'POST',
      path: '/',
      body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body, opts.appSecret),
      },
    });

    expect(res.status).toBe(200);
    expect(received).toEqual([
      { chatId: '15559876543', senderId: '15559876543', senderName: 'Sam', text: 'hello' },
    ]);
  });

  it('rejects a missing or wrong signature with 401 and never calls the handler', async () => {
    const received: IncomingMessage[] = [];
    const { transport, port, controller, done } = await startTransport(opts, async (m) => {
      received.push(m);
    });
    cleanup = async () => {
      controller.abort();
      await done;
    };

    const body = textPayload();
    const res = await request(port, {
      method: 'POST',
      path: '/',
      body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=wrong' },
    });

    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('drops a non-text message type', async () => {
    const received: IncomingMessage[] = [];
    const { transport, port, controller, done } = await startTransport(opts, async (m) => {
      received.push(m);
    });
    cleanup = async () => {
      controller.abort();
      await done;
    };

    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '15559876543', profile: { name: 'Sam' } }],
                messages: [{ from: '15559876543', type: 'image', image: { id: 'x' } }],
              },
            },
          ],
        },
      ],
    });
    await request(port, {
      method: 'POST',
      path: '/',
      body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, opts.appSecret) },
    });

    expect(received).toEqual([]);
  });
});

describe('WhatsAppTransport.receive — lifecycle', () => {
  it('closes the listener when the signal aborts', async () => {
    const { transport, port, controller, done } = await startTransport(opts);
    controller.abort();
    await done;

    await expect(request(port, { method: 'GET', path: '/' })).rejects.toThrow();
  });
});

describe('WhatsAppTransport.send', () => {
  it('posts each chunk and returns the first message id', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return { status: 200, json: async () => ({ messages: [{ id: 'wamid.123' }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const transport = new WhatsAppTransport({ ...opts, fetchImpl });

    const id = await transport.send('15559876543', 'hi there');

    expect(id).toBe('wamid.123');
    expect(calls[0].url).toBe(
      `https://graph.facebook.com/v21.0/${opts.phoneNumberId}/messages`
    );
    expect(calls[0].body).toEqual({
      messaging_product: 'whatsapp',
      to: '15559876543',
      text: { body: 'hi there' },
    });
  });
});

describe('WhatsAppTransport shape', () => {
  it('exposes no edit method', () => {
    const transport = new WhatsAppTransport(opts);
    expect('edit' in transport).toBe(false);
  });

  it('has the expected id and name', () => {
    const transport = new WhatsAppTransport(opts);
    expect(transport.id).toBe('whatsapp');
    expect(transport.name).toBe('WhatsApp');
  });
});
