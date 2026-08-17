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
import * as os from 'node:os';
import { parseAllowlist } from './access.js';
import { UserFacingError } from '../startup/bootstrap.js';

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
  /** Sender ids permitted to drive Robin. */
  allow: string[];
  /** Provider id to answer with. Falls back to the serve command's default. */
  provider?: string;
  model?: string;
}

export function defaultChannelConfigPath(): string {
  return path.join(os.homedir(), '.robin', 'channels.json');
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
  const token = envToken || (typeof record.token === 'string' ? record.token.trim() : '');
  if (!token) {
    throw new UserFacingError(
      `No token for "${channel}". Set ${tokenEnvVar(channel)} or add a "token" to ${filePath}.`
    );
  }

  const allow = parseAllowlist(record.allow);
  if (allow.length === 0 && requireAllowlist) {
    throw new UserFacingError(
      `"${channel}" has an empty "allow" list in ${filePath}, so every message would be refused.\n` +
        `Run \`robin serve ${channel} --whoami\`, message the bot, and it will print the id to add.`
    );
  }

  return {
    token,
    appToken:
      env[appTokenEnvVar(channel)]?.trim() ||
      (typeof record.appToken === 'string' ? record.appToken.trim() : undefined) ||
      undefined,
    allow,
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
  };
}
