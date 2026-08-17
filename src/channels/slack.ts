/**
 * Slack transport, over Socket Mode.
 *
 * Slack's default is a public HTTPS endpoint it can post events to, which a
 * laptop behind NAT does not have. Socket Mode is the outbound alternative:
 * Robin asks Slack for a WebSocket URL and connects to it, the same shape
 * Telegram's long poll and Discord's gateway already use.
 *
 * It needs two credentials, issued separately. The app-level token (xapp-)
 * opens the socket; the bot token (xoxb-) is what acts once it is open.
 */

import WebSocket from 'ws';
import type { ChannelTransport, IncomingMessage } from './types.js';
import { chunkMessage } from './telegram.js';

const API_BASE = 'https://slack.com/api';

/** Slack accepts far more, but long messages read badly in a thread. */
export const SLACK_MAX_MESSAGE = 3500;

const RECONNECT_DELAY_MS = 3000;

interface SlackEnvelope {
  type?: string;
  envelope_id?: string;
  payload?: {
    event?: {
      type?: string;
      subtype?: string;
      text?: string;
      user?: string;
      channel?: string;
      bot_id?: string;
    };
  };
}

export interface SlackOptions {
  /** The bot token, xoxb-. */
  token: string;
  /** The app-level token, xapp-, which opens the socket. */
  appToken: string;
  connectSocket?: (url: string) => WebSocket;
  fetchImpl?: typeof fetch;
}

export class SlackTransport implements ChannelTransport {
  readonly id = 'slack';
  readonly name = 'Slack';

  constructor(private readonly options: SlackOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  /**
   * Slack answers 200 with `ok: false` for a bad token rather than 401, so the
   * body is the only place the real answer is.
   */
  private async call(
    method: string,
    token: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body ?? {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (parsed.ok !== true) {
      throw new Error(`Slack refused ${method}: ${String(parsed.error ?? res.status)}`);
    }
    return parsed;
  }

  async connect(): Promise<{ identity: string }> {
    const me = await this.call('auth.test', this.options.token);
    return { identity: typeof me.user === 'string' ? `@${me.user}` : 'the bot' };
  }

  async receive(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const opened = await this.call('apps.connections.open', this.options.appToken);
        const url = String(opened.url ?? '');
        if (url) await this.runSession(url, handler, signal);
      } catch {
        // A dropped socket is ordinary; Slack cycles them every few hours.
      }
      if (signal.aborted) return;
      await sleep(RECONNECT_DELAY_MS, signal);
    }
  }

  private runSession(
    url: string,
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    const open = this.options.connectSocket ?? ((target: string) => new WebSocket(target));
    const socket = open(url);

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        socket.close();
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });

      socket.on('message', (raw) => {
        let envelope: SlackEnvelope;
        try {
          envelope = JSON.parse(String(raw)) as SlackEnvelope;
        } catch {
          return;
        }

        // Every envelope must be acknowledged, or Slack re-sends it and the
        // same message is answered twice.
        if (envelope.envelope_id && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }
        if (envelope.type === 'disconnect') {
          finish();
          return;
        }

        const event = envelope.payload?.event;
        if (!event || event.type !== 'message') return;
        // A bot_id means us, or another bot. Answering either is how a loop
        // starts. A subtype means an edit, a join, a file share — not someone
        // talking.
        if (event.bot_id || event.subtype) return;
        if (!event.text || !event.user || !event.channel) return;

        void handler({
          chatId: event.channel,
          senderId: event.user,
          senderName: event.user,
          text: event.text,
        });
      });

      socket.on('close', () => {
        signal.removeEventListener('abort', finish);
        resolve();
      });
      socket.on('error', () => {});
    });
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    let firstId: string | undefined;
    for (const chunk of chunkMessage(text, SLACK_MAX_MESSAGE)) {
      const sent = await this.call('chat.postMessage', this.options.token, {
        channel: chatId,
        text: chunk,
      });
      if (firstId === undefined && typeof sent.ts === 'string') firstId = sent.ts;
    }
    return firstId;
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    await this.call('chat.update', this.options.token, {
      channel: chatId,
      ts: messageId,
      text,
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
