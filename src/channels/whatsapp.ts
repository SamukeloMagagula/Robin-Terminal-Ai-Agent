/**
 * WhatsApp transport, over Meta's Business Cloud API.
 *
 * Unlike every other channel here, WhatsApp has no polling mode at all — Meta
 * pushes messages to a webhook URL over HTTPS, with no fallback. So this
 * transport's receive() doesn't poll; it starts its own small HTTP server and
 * resolves when the abort signal fires. That satisfies ChannelTransport's
 * contract ("deliver messages to handler until signal aborts") exactly as
 * well as a poll loop does.
 *
 * This listener is deliberately separate from the gateway's own HTTP server,
 * which binds loopback-only as a security boundary for the sessions/approvals
 * protocol. Extending that server to also take public traffic would widen
 * what a mistake there could reach; a second, single-purpose listener with
 * nothing else riding on it does not.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { ChannelTransport, IncomingMessage } from './types.js';
import { chunkMessage } from './telegram.js';

const API_BASE = 'https://graph.facebook.com/v21.0';

/** Cloud API's documented text message cap. */
const WHATSAPP_MAX_MESSAGE = 4096;

interface WhatsAppMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
}

interface WhatsAppContact {
  wa_id?: string;
  profile?: { name?: string };
}

interface WhatsAppWebhookBody {
  entry?: {
    changes?: {
      value?: {
        contacts?: WhatsAppContact[];
        messages?: WhatsAppMessage[];
      };
    }[];
  }[];
}

export interface WhatsAppOptions {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
  webhookPort: number;
  /** Interface to bind. Defaults to '0.0.0.0'. Overridable for tests. */
  bindHost?: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class WhatsAppTransport implements ChannelTransport {
  readonly id = 'whatsapp';
  readonly name = 'WhatsApp';

  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly verifyToken: string;
  private readonly appSecret: string;
  private readonly webhookPort: number;
  private readonly bindHost: string;
  private readonly fetchImpl: typeof fetch;
  private listeningListeners: ((port: number) => void)[] = [];

  constructor(options: WhatsAppOptions) {
    this.token = options.token;
    this.phoneNumberId = options.phoneNumberId;
    this.verifyToken = options.verifyToken;
    this.appSecret = options.appSecret;
    this.webhookPort = options.webhookPort;
    this.bindHost = options.bindHost ?? '0.0.0.0';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fires once the webhook listener is bound and its real port is known —
   * needed because tests run with webhookPort 0 (OS-assigned) and production
   * with a fixed port neither of which is knowable before listen() completes.
   */
  onListening(handler: (port: number) => void): void {
    this.listeningListeners.push(handler);
  }

  async connect(): Promise<{ identity: string }> {
    const response = await this.fetchImpl(`${API_BASE}/${this.phoneNumberId}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    const payload = (await response.json().catch(() => null)) as
      | { display_phone_number?: string; error?: { message?: string } }
      | null;
    if (response.status < 200 || response.status >= 300) {
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`WhatsApp connect failed: ${detail}`);
    }
    return { identity: payload?.display_phone_number ?? 'unknown number' };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    let firstId: string | undefined;
    for (const chunk of chunkMessage(text, WHATSAPP_MAX_MESSAGE)) {
      const response = await this.fetchImpl(`${API_BASE}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: chatId,
          text: { body: chunk },
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { messages?: { id?: string }[]; error?: { message?: string } }
        | null;
      if (response.status < 200 || response.status >= 300) {
        const detail = payload?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`WhatsApp send failed: ${detail}`);
      }
      if (firstId === undefined && payload?.messages?.[0]?.id) {
        firstId = payload.messages[0].id;
      }
    }
    return firstId;
  }

  async receive(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res, handler).catch((err) => {
          console.error(`WhatsApp webhook handler failed — ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });

      server.listen(this.webhookPort, this.bindHost, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : this.webhookPort;
        for (const listener of this.listeningListeners) listener(port);
      });

      signal.addEventListener('abort', () => {
        server.close(() => resolve());
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (message: IncomingMessage) => Promise<void>
  ): Promise<void> {
    if (req.method === 'GET') {
      this.handleVerification(req, res);
      return;
    }

    if (req.method === 'POST') {
      await this.handleInbound(req, res, handler);
      return;
    }

    res.writeHead(405);
    res.end();
  }

  /** Meta's one-time (and re-verifiable-any-time) webhook subscription check. */
  private handleVerification(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === this.verifyToken && challenge !== null) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(challenge);
      return;
    }
    res.writeHead(403);
    res.end();
  }

  private async handleInbound(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (message: IncomingMessage) => Promise<void>
  ): Promise<void> {
    const body = await readBody(req);

    // The raw body is checked before it is trusted enough to parse — parsing
    // first would mean acting on the shape of unverified data.
    const signature = req.headers['x-hub-signature-256'];
    if (!isValidSignature(body, typeof signature === 'string' ? signature : '', this.appSecret)) {
      res.writeHead(401);
      res.end();
      return;
    }

    // Meta expects a fast ack and retries on timeout, so the response goes
    // out before the handler runs.
    res.writeHead(200);
    res.end();

    let parsed: WhatsAppWebhookBody;
    try {
      parsed = JSON.parse(body) as WhatsAppWebhookBody;
    } catch {
      return;
    }

    for (const message of extractMessages(parsed)) {
      try {
        await handler(message);
      } catch (err) {
        console.error(`Handler failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function isValidSignature(body: string, header: string, secret: string): boolean {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const headerBuf = Buffer.from(header);
  if (expectedBuf.length !== headerBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, headerBuf);
}

/** Maps every text message in a webhook body to our shape, dropping the rest. */
function extractMessages(body: WhatsAppWebhookBody): IncomingMessage[] {
  const result: IncomingMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const contacts = value?.contacts ?? [];
      for (const message of value?.messages ?? []) {
        if (message.type !== 'text' || !message.text?.body || !message.from) continue;
        const contact = contacts.find((c) => c.wa_id === message.from);
        result.push({
          chatId: message.from,
          senderId: message.from,
          senderName: contact?.profile?.name,
          text: message.text.body,
        });
      }
    }
  }
  return result;
}
