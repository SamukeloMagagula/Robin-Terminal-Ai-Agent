/**
 * iMessage transport, over BlueBubbles Server.
 *
 * iMessage has no official bot API — Messages.app is the only client, and it
 * only runs on macOS with an Apple ID signed in. The self-hosted answer is
 * BlueBubbles Server, the same role signal-cli-rest-api plays for Signal:
 * plain HTTP polling, no new protocol code. Robin does not manage that
 * server; it is a client of it, the same relationship it has to a Telegram
 * bot token or a Signal container.
 */

import type { ChannelTransport, IncomingMessage } from './types.js';

/** Matches Signal's polling cadence — no long-poll mode on this endpoint either. */
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Backoff after a failed poll, so a network outage does not become a hot loop. */
const RETRY_DELAY_MS = 3000;

interface BlueBubblesMessage {
  guid?: string;
  text?: string | null;
  dateCreated?: number;
  isFromMe?: boolean;
  handle?: { address?: string };
  chats?: { guid?: string }[];
}

export interface IMessageOptions {
  apiUrl: string;
  password: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so polling does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for tests; defaults to 2000. */
  pollIntervalMs?: number;
}

export class IMessageTransport implements ChannelTransport {
  readonly id = 'imessage';
  readonly name = 'iMessage';

  private readonly apiUrl: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(options: IMessageOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async connect(): Promise<{ identity: string }> {
    const response = await this.fetchImpl(
      `${this.apiUrl}/api/v1/ping?password=${encodeURIComponent(this.password)}`
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`BlueBubbles /api/v1/ping failed: HTTP ${response.status}`);
    }
    return { identity: this.apiUrl };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const response = await this.fetchImpl(
      `${this.apiUrl}/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatGuid: chatId, message: text }),
      }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`BlueBubbles /api/v1/message/text failed: HTTP ${response.status}`);
    }
    const payload = (await response.json().catch(() => null)) as { data?: { guid?: string } } | null;
    return payload?.data?.guid;
  }

  private async query(body: Record<string, unknown>): Promise<BlueBubblesMessage[]> {
    const response = await this.fetchImpl(
      `${this.apiUrl}/api/v1/message/query?password=${encodeURIComponent(this.password)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { data?: BlueBubblesMessage[] };
    return payload.data ?? [];
  }

  /**
   * A message that existed before receive() was called must never reach
   * handler unprompted — mirrors Telegram's drainBacklog. A failure here is
   * not fatal: it just means the cursor falls back to "now."
   */
  private async seedCursor(): Promise<number> {
    try {
      const latest = await this.query({ limit: 1, sort: 'DESC', with: ['chats', 'handle'] });
      return latest[0]?.dateCreated ?? Date.now();
    } catch {
      return Date.now();
    }
  }

  async receive(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    let cursor = await this.seedCursor();

    while (!signal.aborted) {
      let messages: BlueBubblesMessage[];
      try {
        messages = await this.query({
          after: cursor,
          sort: 'ASC',
          limit: 100,
          with: ['chats', 'handle'],
        });
      } catch (err) {
        if (signal.aborted) return;
        console.error(`iMessage poll failed, retrying — ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }

      for (const raw of messages) {
        // Moves past every message, dropped or not — or a from-me message
        // would be re-fetched on every poll forever.
        if (raw.dateCreated !== undefined) cursor = Math.max(cursor, raw.dateCreated);

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

/**
 * Every message BlueBubbles reports — including robin's own replies — comes
 * back through this same query, since they were all sent from the single
 * Apple ID robin polls as. isFromMe: true is dropped here, or robin would
 * answer its own replies in a loop.
 */
function toIncoming(raw: BlueBubblesMessage): IncomingMessage | null {
  const chatGuid = raw.chats?.[0]?.guid;
  const address = raw.handle?.address;
  if (raw.isFromMe || !raw.text || !chatGuid || !address) return null;
  return {
    chatId: chatGuid,
    senderId: address,
    senderName: undefined,
    text: raw.text,
  };
}
