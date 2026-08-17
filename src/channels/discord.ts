/**
 * Discord transport, over the gateway WebSocket.
 *
 * Same reasoning as Telegram's long polling: the gateway is an outbound
 * connection from behind whatever NAT or firewall the machine is on, so
 * nothing has to be reachable from the internet. Discord has no polling API,
 * but its gateway is a plain WebSocket and `ws` is already here for the
 * daemon.
 */

import WebSocket from 'ws';
import type { ChannelTransport, IncomingMessage } from './types.js';
import { chunkMessage } from './telegram.js';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const API_BASE = 'https://discord.com/api/v10';

/** Discord rejects messages over 2000 characters. */
export const DISCORD_MAX_MESSAGE = 1900;

/** Backoff after a dropped connection, so an outage does not become a hot loop. */
const RECONNECT_DELAY_MS = 3000;

/**
 * What the bot asks to be told about.
 *
 * GUILD_MESSAGES and DIRECT_MESSAGES are the channels a message can arrive on.
 * MESSAGE_CONTENT is **privileged**: without it enabled on the application's
 * page in Discord's developer portal, every message arrives with empty content
 * and the bot appears to ignore everyone.
 */
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface DiscordMessage {
  channel_id: string;
  content?: string;
  author?: { id: string; username?: string; bot?: boolean };
}

export interface DiscordOptions {
  token: string;
  /** Injected in tests so the gateway can be driven without a network. */
  connectSocket?: (url: string) => WebSocket;
  fetchImpl?: typeof fetch;
}

export class DiscordTransport implements ChannelTransport {
  readonly id = 'discord';
  readonly name = 'Discord';

  private identity = 'unknown';

  constructor(private readonly options: DiscordOptions) {}

  /**
   * Verifies the token before any socket is opened.
   *
   * The gateway reports a bad token by closing with an opaque code, which is a
   * poor thing to hand an operator. `/users/@me` says so in words.
   */
  async connect(): Promise<{ identity: string }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(`${API_BASE}/users/@me`, {
      headers: { authorization: `Bot ${this.options.token}` },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? 'Discord rejected the bot token. Check DISCORD_BOT_TOKEN, or the "token" in channels.json.'
          : `Discord refused the connection: ${res.status}.`
      );
    }
    const me = (await res.json()) as { username?: string; discriminator?: string };
    this.identity = me.username ? `@${me.username}` : 'the bot';
    return { identity: this.identity };
  }

  async receive(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runSession(handler, signal);
      } catch {
        // A dropped gateway is ordinary — Discord cycles them. Anything that
        // exits here rather than retrying is not something to leave running.
      }
      if (signal.aborted) return;
      await sleep(RECONNECT_DELAY_MS, signal);
    }
  }

  /** One gateway connection, from HELLO until it closes. */
  private runSession(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    const open = this.options.connectSocket ?? ((url: string) => new WebSocket(url));
    const socket = open(GATEWAY_URL);

    return new Promise<void>((resolve) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let lastSequence: number | null = null;

      const finish = (): void => {
        if (heartbeat) clearInterval(heartbeat);
        socket.close();
        resolve();
      };

      const abort = (): void => finish();
      signal.addEventListener('abort', abort, { once: true });

      socket.on('message', (raw) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(String(raw)) as GatewayFrame;
        } catch {
          return;
        }
        if (typeof frame.s === 'number') lastSequence = frame.s;

        // HELLO: start heartbeating, then say who we are.
        if (frame.op === 10) {
          const interval = (frame.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 45000;
          heartbeat = setInterval(() => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ op: 1, d: lastSequence }));
            }
          }, interval);
          heartbeat.unref?.();
          socket.send(
            JSON.stringify({
              op: 2,
              d: {
                token: this.options.token,
                intents: INTENTS,
                properties: { os: process.platform, browser: 'robin', device: 'robin' },
              },
            })
          );
          return;
        }

        // INVALID_SESSION or RECONNECT: the loop above reconnects.
        if (frame.op === 9 || frame.op === 7) {
          finish();
          return;
        }

        if (frame.op !== 0 || frame.t !== 'MESSAGE_CREATE') return;
        const message = frame.d as DiscordMessage;

        // Never answer a bot, which includes ourselves. Without this the bot
        // replies to its own reply, forever.
        if (!message?.author || message.author.bot === true) return;
        if (!message.content) return;

        void handler({
          chatId: message.channel_id,
          senderId: message.author.id,
          senderName: message.author.username,
          text: message.content,
        });
      });

      socket.on('close', () => {
        signal.removeEventListener('abort', abort);
        if (heartbeat) clearInterval(heartbeat);
        resolve();
      });
      // An error is always followed by a close, which resolves this.
      socket.on('error', () => {});
    });
  }

  async send(chatId: string, text: string): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    for (const chunk of chunkMessage(text, DISCORD_MAX_MESSAGE)) {
      await fetchImpl(`${API_BASE}/channels/${chatId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bot ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: chunk }),
      });
    }
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
