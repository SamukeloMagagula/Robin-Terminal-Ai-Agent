import { TelegramTransport } from './telegram.js';
import { DiscordTransport } from './discord.js';
import { SlackTransport } from './slack.js';
import { SignalTransport } from './signal.js';
import type { ChannelTransport } from './types.js';
import { UserFacingError } from '../startup/bootstrap.js';

/**
 * Channels Robin can be driven from.
 *
 * Telegram is implemented. WhatsApp and Teams are named here rather than
 * omitted so `robin serve whatsapp` explains where the work stands instead of
 * reporting an unknown command — both need a different kind of plumbing than
 * a bot token (a Business API number and a verified webhook; an Azure app
 * registration and a Bot Framework endpoint), and neither can long-poll from
 * a laptop the way Telegram does.
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
    pending:
      'WhatsApp needs a Meta Business account, a registered phone number and a public webhook — ' +
      'it cannot long-poll from this machine. The bridge and access layer are already shared, ' +
      'so it is a transport adapter plus a webhook listener.',
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
