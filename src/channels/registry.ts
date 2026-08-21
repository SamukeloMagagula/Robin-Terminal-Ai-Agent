import { TelegramTransport } from './telegram.js';
import { DiscordTransport } from './discord.js';
import { SlackTransport } from './slack.js';
import { SignalTransport } from './signal.js';
import { WhatsAppTransport } from './whatsapp.js';
import { IMessageTransport } from './imessage.js';
import type { ChannelTransport } from './types.js';
import { UserFacingError } from '../startup/bootstrap.js';

/**
 * Channels Robin can be driven from.
 *
 * Teams is named here rather than omitted so `robin serve teams` explains
 * where the work stands instead of reporting an unknown command — it needs a
 * different kind of plumbing than a bot token (an Azure app registration and
 * a Bot Framework endpoint reachable from Microsoft's cloud), and cannot
 * long-poll from a laptop the way Telegram does.
 *
 * Lives here rather than in serve-command because the scheduler needs the
 * same table: delivering a job's answer uses the send half of a transport,
 * without any of the receiving a bridge does.
 */
export const CHANNELS: Record<
  string,
  {
    build?: (config: {
      token: string;
      appToken?: string;
      apiUrl?: string;
      phoneNumber?: string;
      phoneNumberId?: string;
      verifyToken?: string;
      appSecret?: string;
      webhookPort?: number;
    }) => ChannelTransport;
    pending?: string;
  }
> = {
  telegram: { build: ({ token }) => new TelegramTransport({ token }) },
  discord: { build: ({ token }) => new DiscordTransport({ token }) },
  slack: {
    build: ({ token, appToken }) => {
      if (!appToken) {
        throw new UserFacingError(
          'Slack needs an app-level token as well as a bot token. Set SLACK_APP_TOKEN, ' +
            'or add "appToken" to the slack entry in ~/.robin/channels.json.\n\n' +
            'The app-level token starts xapp- and is created under Basic Information → ' +
            'App-Level Tokens with the connections:write scope.'
        );
      }
      return new SlackTransport({ token, appToken });
    },
  },
  signal: {
    build: ({ apiUrl, phoneNumber }) => {
      if (!apiUrl || !phoneNumber) {
        throw new UserFacingError(
          'Signal needs an apiUrl and a phoneNumber. Set SIGNAL_API_URL and SIGNAL_PHONE_NUMBER, ' +
            'or add them to the signal entry in ~/.robin/channels.json.'
        );
      }
      return new SignalTransport({ apiUrl, phoneNumber });
    },
  },
  whatsapp: {
    build: ({ token, phoneNumberId, verifyToken, appSecret, webhookPort }) => {
      if (!phoneNumberId || !verifyToken || !appSecret || webhookPort === undefined) {
        throw new UserFacingError(
          'WhatsApp needs phoneNumberId, verifyToken, appSecret and webhookPort. Set ' +
            'WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET and ' +
            'WHATSAPP_WEBHOOK_PORT, or add them to the whatsapp entry in ~/.robin/channels.json.'
        );
      }
      return new WhatsAppTransport({ token, phoneNumberId, verifyToken, appSecret, webhookPort });
    },
  },
  imessage: {
    build: ({ apiUrl, token }) => {
      if (!apiUrl) {
        throw new UserFacingError(
          'iMessage needs an apiUrl. Set IMESSAGE_API_URL, or add an "apiUrl" ' +
            'to the imessage entry in ~/.robin/channels.json.'
        );
      }
      return new IMessageTransport({ apiUrl, password: token });
    },
  },
  teams: {
    pending:
      'Teams needs an Azure app registration and a Bot Framework messaging endpoint reachable from ' +
      'Microsoft’s cloud. Same shape as WhatsApp: a transport adapter plus a webhook listener.',
  },
};

export function channelNames(): string[] {
  return Object.keys(CHANNELS);
}
