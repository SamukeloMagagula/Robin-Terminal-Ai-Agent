/**
 * Signal transport, over signal-cli-rest-api.
 *
 * Signal has no official bot API. The self-hosted answer is signal-cli, and
 * this talks to it through the community REST wrapper
 * (bbernhard/signal-cli-rest-api) rather than signal-cli's own JSON-RPC
 * socket — plain HTTP polling, the same shape as Telegram's long-poll, with
 * no new protocol code. Robin does not manage that container; it is a client
 * of it, the same relationship it has to a Telegram bot token.
 */

import type { ChannelTransport, IncomingMessage } from './types.js';

/**
 * The receive endpoint returns whatever is queued right now — no long-poll
 * timeout the way Telegram's getUpdates has — so avoiding a hot loop means
 * polling on a fixed interval instead.
 */
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Backoff after a failed poll, so a network outage does not become a hot loop. */
const RETRY_DELAY_MS = 3000;

interface SignalEnvelope {
  envelope?: {
    source?: string;
    sourceName?: string;
    dataMessage?: {
      message?: string;
      groupInfo?: { groupId?: string };
    };
  };
}

export interface SignalOptions {
  apiUrl: string;
  phoneNumber: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so polling does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for tests; defaults to 2000. */
  pollIntervalMs?: number;
}

export class SignalTransport implements ChannelTransport {
  readonly id = 'signal';
  readonly name = 'Signal';

  private readonly apiUrl: string;
  private readonly phoneNumber: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(options: SignalOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.phoneNumber = options.phoneNumber;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async connect(): Promise<{ identity: string }> {
    const response = await this.fetchImpl(`${this.apiUrl}/v1/about`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`signal-cli-rest-api /v1/about failed: HTTP ${response.status}`);
    }
    return { identity: this.phoneNumber };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const response = await this.fetchImpl(`${this.apiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, number: this.phoneNumber, recipients: [chatId] }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`signal-cli-rest-api /v2/send failed: HTTP ${response.status}`);
    }
    const payload = (await response.json().catch(() => null)) as { timestamp?: number } | null;
    return payload?.timestamp !== undefined ? String(payload.timestamp) : undefined;
  }

  async receive(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      let envelopes: SignalEnvelope[];
      try {
        const response = await this.fetchImpl(
          `${this.apiUrl}/v1/receive/${encodeURIComponent(this.phoneNumber)}`
        );
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}`);
        }
        envelopes = (await response.json()) as SignalEnvelope[];
      } catch (err) {
        if (signal.aborted) return;
        console.error(`Signal poll failed, retrying — ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }

      for (const raw of envelopes) {
        const message = toIncoming(raw);
        if (!message) continue;
        // Handler errors must not kill the poll loop — one malformed request
        // would otherwise take the whole bridge offline.
        try {
          await handler(message);
        } catch (err) {
          console.error(`Handler failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (signal.aborted) return;
      await this.sleep(this.pollIntervalMs);
    }
  }
}

/** Maps a raw envelope to our shape, dropping anything without usable text. */
function toIncoming(raw: SignalEnvelope): IncomingMessage | null {
  const envelope = raw.envelope;
  const text = envelope?.dataMessage?.message;
  const source = envelope?.source;
  if (!envelope || !text || !source) return null;
  const groupId = envelope.dataMessage?.groupInfo?.groupId;
  return {
    chatId: groupId ?? source,
    senderId: source,
    senderName: envelope.sourceName,
    text,
  };
}
