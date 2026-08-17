/**
 * Telegram transport, over the Bot API's long-polling endpoint.
 *
 * Long polling rather than webhooks on purpose: a webhook needs a public
 * HTTPS endpoint, which means either exposing a port from the operator's
 * laptop or standing up a relay. Long polling is an outbound connection from
 * behind whatever NAT or corporate firewall the machine is on, and needs no
 * inbound reachability at all.
 */

import type { ChannelTransport, IncomingMessage } from './types.js';

const API_BASE = 'https://api.telegram.org';

/**
 * How long Telegram holds an empty poll open. 25s stays comfortably inside
 * common proxy idle timeouts (typically 30–60s) while keeping the request
 * count low enough to be invisible against the API's rate limits.
 */
const POLL_TIMEOUT_SECONDS = 25;

/** Backoff after a failed poll, so a network outage does not become a hot loop. */
const RETRY_DELAY_MS = 3000;

/**
 * Telegram rejects messages over 4096 characters. Splitting at 3500 leaves
 * room for the part counter without a second length calculation.
 */
export const TELEGRAM_MAX_MESSAGE = 3500;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
  };
}

/**
 * Splits a reply into sendable chunks, preferring to break at a blank line,
 * then at a newline, and only mid-line as a last resort — a code block split
 * at an arbitrary column is unreadable in a chat client.
 */
export function chunkMessage(text: string, limit: number = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    // A break in the first 20% would produce a near-empty chunk and many more
    // messages than necessary, so below that a hard split is the better trade.
    const splitAt = breakAt > limit * 0.2 ? breakAt : limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface TelegramOptions {
  token: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so backoff does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
}

export class TelegramTransport implements ChannelTransport {
  readonly id = 'telegram';
  readonly name = 'Telegram';

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Telegram redelivers every update until one past it is acknowledged. */
  private offset = 0;

  constructor(options: TelegramOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    // Read the body before checking status: Telegram puts its actual
    // explanation in `description`, and "HTTP 401" alone does not tell the
    // operator their token is wrong.
    const payload = (await response.json().catch(() => null)) as
      | { ok: boolean; result?: T; description?: string }
      | null;

    if (!payload?.ok) {
      const detail = payload?.description ?? `HTTP ${response.status}`;
      throw new Error(`Telegram ${method} failed: ${detail}`);
    }
    return payload.result as T;
  }

  async connect(): Promise<{ identity: string }> {
    const me = await this.call<{ username?: string; first_name?: string }>('getMe', {});
    return { identity: me.username ? `@${me.username}` : (me.first_name ?? 'unknown bot') };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    let firstId: string | undefined;
    for (const chunk of chunkMessage(text)) {
      // No parse_mode: model output is arbitrary text, and Telegram rejects
      // the whole message when it contains an unbalanced Markdown entity —
      // a stray asterisk would silently drop the reply.
      const sent = await this.call<{ message_id?: number }>('sendMessage', {
        chat_id: chatId,
        text: chunk,
      });
      if (firstId === undefined && typeof sent.message_id === 'number') {
        firstId = String(sent.message_id);
      }
    }
    return firstId;
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
    });
  }

  async receive(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    // Clears any backlog queued while the bridge was down. Acting on messages
    // sent hours ago, unprompted, is surprising in a way that matters when the
    // action is running commands.
    await this.drainBacklog(signal);

    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message'] },
          signal
        );
      } catch (err) {
        if (signal.aborted) return;
        // Transient by assumption: a wrong token would have failed connect().
        console.error(`Telegram poll failed, retrying — ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }

      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const message = toIncoming(update);
        if (!message) continue;
        // Handler errors must not kill the poll loop — one malformed request
        // would otherwise take the whole bridge offline.
        try {
          await handler(message);
        } catch (err) {
          console.error(`Handler failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /** Acknowledges everything already queued without acting on any of it. */
  private async drainBacklog(signal: AbortSignal): Promise<void> {
    try {
      const pending = await this.call<TelegramUpdate[]>(
        'getUpdates',
        { offset: -1, timeout: 0 },
        signal
      );
      const last = pending.at(-1);
      if (last) this.offset = last.update_id + 1;
    } catch {
      // A failure here only means the first poll may replay a backlog, which
      // is not worth refusing to start over.
    }
  }
}

/** Maps a raw update to our shape, dropping anything without usable text. */
function toIncoming(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message;
  if (!message?.text || !message.from) return null;
  return {
    chatId: String(message.chat.id),
    senderId: String(message.from.id),
    senderName: message.from.username ?? message.from.first_name,
    text: message.text,
  };
}
