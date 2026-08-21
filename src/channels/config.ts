/**
 * Channel configuration, from ~/.robin/channels.json.
 *
 * Unlike mcp.json this does *not* fail closed to an empty config and carry on:
 * `robin serve` was asked to bring a specific channel online, and starting
 * something that silently refuses every message is worse than refusing to
 * start. Every problem here is thrown with the fix in the message.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseAllowlist } from './access.js';
import { UserFacingError } from '../startup/bootstrap.js';
import { robinHome } from '../profile.js';

export interface ChannelConfig {
  /** Bot credential. Read from the environment in preference to the file. */
  token: string;
  /**
   * A second credential, where the platform needs one.
   *
   * Slack is the reason this exists: its Socket Mode wants an app-level token
   * to open the connection and a bot token to act, and they are issued
   * separately. Absent for every other channel.
   */
  appToken?: string;
  /** Base URL of the signal-cli-rest-api container, or a BlueBubbles Server. Signal and iMessage only. */
  apiUrl?: string;
  /** The registered Signal number, E.164 format. Signal only — this is the
   *  channel's identity, in the role a bot token plays for every other
   *  channel. */
  phoneNumber?: string;
  /** Meta's numeric id for the sending number. WhatsApp only. */
  phoneNumberId?: string;
  /** Arbitrary string echoed back during the one-time webhook-verification
   *  handshake. WhatsApp only. */
  verifyToken?: string;
  /** Verifies X-Hub-Signature-256 on every inbound webhook POST. WhatsApp
   *  only, and not optional in practice. */
  appSecret?: string;
  /** Port the WhatsApp webhook listener binds. WhatsApp only. */
  webhookPort?: number;
  /** Sender ids permitted to drive Robin. */
  allow: string[];
  /** Provider id to answer with. Falls back to the serve command's default. */
  provider?: string;
  model?: string;
}

export function defaultChannelConfigPath(): string {
  return path.join(robinHome(), 'channels.json');
}

/** e.g. TELEGRAM_BOT_TOKEN — the conventional name, and what most guides use. */
export function tokenEnvVar(channel: string): string {
  return `${channel.toUpperCase()}_BOT_TOKEN`;
}

/** e.g. SLACK_APP_TOKEN, for the platforms that issue two credentials. */
export function appTokenEnvVar(channel: string): string {
  return `${channel.toUpperCase()}_APP_TOKEN`;
}

export const EXAMPLE_CONFIG = `{
  "channels": {
    "telegram": {
      "token": "123456:ABC-your-bot-token",
      "allow": ["987654321"],
      "provider": "copilot",
      "model": "claude-sonnet-5"
    },
    "discord": {
      "token": "your-discord-bot-token",
      "allow": ["your-discord-user-id"]
    },
    "slack": {
      "token": "xoxb-your-bot-token",
      "appToken": "xapp-your-app-level-token",
      "allow": ["U0123456789"]
    },
    "signal": {
      "phoneNumber": "+15551234567",
      "apiUrl": "http://localhost:8080",
      "allow": ["+15559876543"]
    },
    "whatsapp": {
      "token": "your-cloud-api-access-token",
      "phoneNumberId": "109876543210987",
      "verifyToken": "any-string-you-pick",
      "appSecret": "your-meta-app-secret",
      "webhookPort": 8443,
      "allow": ["15551234567"]
    },
    "imessage": {
      "token": "your-bluebubbles-server-password",
      "apiUrl": "http://localhost:1234",
      "allow": ["+15559876543"]
    }
  }
}`;

/**
 * Reads one channel's config.
 *
 * The token may come from the environment instead of the file, which is the
 * better habit: channels.json is a plain file in the home directory, and a
 * long-lived bot token in it is a credential at rest that gets copied around
 * with dotfiles. The environment variable wins when both are present.
 */
export interface LoadOptions {
  /**
   * False in `--whoami` discovery mode, which exists precisely because you
   * cannot know your own sender id until something reports it. That mode never
   * reaches the model, so an empty allowlist is safe there and only there.
   */
  requireAllowlist?: boolean;
}

export async function loadChannelConfig(
  channel: string,
  filePath: string = defaultChannelConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
  options: LoadOptions = {}
): Promise<ChannelConfig> {
  const requireAllowlist = options.requireAllowlist ?? true;
  const envToken = env[tokenEnvVar(channel)]?.trim();

  let raw: string | null = null;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    throw new UserFacingError(
      `No channel config at ${filePath}. Create it with:\n\n${EXAMPLE_CONFIG}\n\n` +
        `The token can also come from ${tokenEnvVar(channel)} instead of the file.`
    );
  }

  let parsed: { channels?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { channels?: Record<string, unknown> };
  } catch (err) {
    throw new UserFacingError(
      `${filePath} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const entry = parsed.channels?.[channel];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new UserFacingError(
      `No "${channel}" entry in ${filePath}. Add one:\n\n${EXAMPLE_CONFIG}`
    );
  }

  const record = entry as Record<string, unknown>;

  const allow = parseAllowlist(record.allow);
  if (allow.length === 0 && requireAllowlist) {
    throw new UserFacingError(
      `"${channel}" has an empty "allow" list in ${filePath}, so every message would be refused.\n` +
        `Run \`robin serve ${channel} --whoami\`, message the bot, and it will print the id to add.`
    );
  }

  const provider = typeof record.provider === 'string' ? record.provider : undefined;
  const model = typeof record.model === 'string' ? record.model : undefined;

  // Signal has no bot token — a registered phone number and a reachable
  // signal-cli-rest-api URL play that role instead, so it skips the generic
  // token check below in favour of its own two.
  if (channel === 'signal') {
    const phoneNumber =
      env.SIGNAL_PHONE_NUMBER?.trim() ||
      (typeof record.phoneNumber === 'string' ? record.phoneNumber.trim() : '');
    if (!phoneNumber) {
      throw new UserFacingError(
        `No phone number for "signal". Set SIGNAL_PHONE_NUMBER or add a "phoneNumber" to ${filePath}.`
      );
    }
    const apiUrl =
      env.SIGNAL_API_URL?.trim() || (typeof record.apiUrl === 'string' ? record.apiUrl.trim() : '');
    if (!apiUrl) {
      throw new UserFacingError(
        `No API URL for "signal". Set SIGNAL_API_URL or add an "apiUrl" to ${filePath}.`
      );
    }
    return { token: phoneNumber, phoneNumber, apiUrl, allow, provider, model };
  }

  const token = envToken || (typeof record.token === 'string' ? record.token.trim() : '');
  if (!token) {
    throw new UserFacingError(
      `No token for "${channel}". Set ${tokenEnvVar(channel)} or add a "token" to ${filePath}.`
    );
  }

  // iMessage's token is the BlueBubbles server password; it also needs the
  // server's URL, the same role apiUrl plays for Signal.
  if (channel === 'imessage') {
    const apiUrl =
      env.IMESSAGE_API_URL?.trim() || (typeof record.apiUrl === 'string' ? record.apiUrl.trim() : '');
    if (!apiUrl) {
      throw new UserFacingError(
        `No API URL for "imessage". Set IMESSAGE_API_URL or add an "apiUrl" to ${filePath}.`
      );
    }
    return { token, apiUrl, allow, provider, model };
  }

  // WhatsApp's webhook needs three more credentials beyond the access token,
  // plus the port its listener binds — none of which any other channel has.
  if (channel === 'whatsapp') {
    const phoneNumberId =
      env.WHATSAPP_PHONE_NUMBER_ID?.trim() ||
      (typeof record.phoneNumberId === 'string' ? record.phoneNumberId.trim() : '');
    if (!phoneNumberId) {
      throw new UserFacingError(
        `No phone number id for "whatsapp". Set WHATSAPP_PHONE_NUMBER_ID or add a "phoneNumberId" to ${filePath}.`
      );
    }
    const verifyToken =
      env.WHATSAPP_VERIFY_TOKEN?.trim() ||
      (typeof record.verifyToken === 'string' ? record.verifyToken.trim() : '');
    if (!verifyToken) {
      throw new UserFacingError(
        `No verify token for "whatsapp". Set WHATSAPP_VERIFY_TOKEN or add a "verifyToken" to ${filePath}.`
      );
    }
    const appSecret =
      env.WHATSAPP_APP_SECRET?.trim() ||
      (typeof record.appSecret === 'string' ? record.appSecret.trim() : '');
    if (!appSecret) {
      throw new UserFacingError(
        `No app secret for "whatsapp". Set WHATSAPP_APP_SECRET or add an "appSecret" to ${filePath}.`
      );
    }
    const webhookPortRaw =
      env.WHATSAPP_WEBHOOK_PORT?.trim() ||
      (typeof record.webhookPort === 'number' ? String(record.webhookPort) : '');
    const webhookPort = webhookPortRaw === '' ? NaN : Number(webhookPortRaw);
    if (webhookPortRaw === '' || Number.isNaN(webhookPort)) {
      throw new UserFacingError(
        `No webhook port for "whatsapp". Set WHATSAPP_WEBHOOK_PORT or add a "webhookPort" to ${filePath}.`
      );
    }
    return {
      token,
      phoneNumberId,
      verifyToken,
      appSecret,
      webhookPort,
      allow,
      provider,
      model,
    };
  }

  return {
    token,
    appToken:
      env[appTokenEnvVar(channel)]?.trim() ||
      (typeof record.appToken === 'string' ? record.appToken.trim() : undefined) ||
      undefined,
    allow,
    provider,
    model,
  };
}
