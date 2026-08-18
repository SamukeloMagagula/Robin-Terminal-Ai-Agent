import chalk from 'chalk';
import type { Provider } from '../providers/types.js';
import { getProvider, listProviders } from '../providers/index.js';
import { mutedColor, divider } from '../ui/theme.js';
import { loadChannelConfig, tokenEnvVar, appTokenEnvVar } from '../channels/config.js';
import { ChannelBridge } from '../channels/bridge.js';
import { CHANNELS } from '../channels/registry.js';
import { AutonomyStore } from '../autonomy/grant-store.js';
import type { ChannelTransport } from '../channels/types.js';
import { UserFacingError } from '../startup/bootstrap.js';
import { ensureGateway } from '../gateway/ensure.js';
import { GatewayClient } from '../gateway/client.js';


export interface ServeOptions {
  provider?: string;
  model?: string;
  allowTools?: boolean;
  whoami?: boolean;
  /** A capability manifest the chat may act under. See `robin autonomy`. */
  manifest?: string;
}

async function resolveProvider(id: string | undefined): Promise<Provider> {
  if (id) {
    const provider = getProvider(id);
    if (!(await provider.isAuthenticated())) {
      throw new UserFacingError(`Not logged in to ${provider.name}. Run \`robin login ${provider.id}\` first.`);
    }
    return provider;
  }
  // No provider named anywhere: take the first that is actually usable, so
  // the common case needs no configuration at all.
  for (const provider of listProviders()) {
    try {
      if (await provider.isAuthenticated()) return provider;
    } catch {
      // Not usable; keep looking.
    }
  }
  throw new UserFacingError('No provider is logged in. Run `robin login <provider>` first.');
}

async function resolveModel(provider: Provider, requested: string | undefined): Promise<string> {
  if (requested) return requested;
  const models = await provider.listModels();
  if (models.length === 0) throw new Error(`${provider.name} offers no models.`);
  return models[0];
}

/**
 * Discovery mode: prints the sender id of anyone who messages the bot and
 * nothing else. No session, no model, no tools — it exists solely to answer
 * "what do I put in the allow list?", which is otherwise unanswerable without
 * already being on it.
 */
async function runWhoami(transport: ChannelTransport, signal: AbortSignal): Promise<void> {
  const { identity } = await transport.connect();
  console.log(`${transport.name} connected as ${identity}`);
  console.log(mutedColor('Discovery mode — message the bot and your id will appear below.'));
  console.log(mutedColor('Nothing is sent to the model. Press Ctrl+C when you have it.\n'));

  await transport.receive(async (message) => {
    console.log(
      `${chalk.green('sender id:')} ${chalk.bold(message.senderId)}   ${mutedColor(
        `(${message.senderName ?? 'no name'}, chat ${message.chatId})`
      )}`
    );
    await transport.send(
      message.chatId,
      `Your sender id is ${message.senderId}. Add it to the "allow" list in channels.json.`
    );
  }, signal);
}

export async function runServe(channelName: string, options: ServeOptions): Promise<void> {
  const channel = CHANNELS[channelName];
  if (!channel) {
    throw new UserFacingError(
      `Unknown channel "${channelName}". Available: ${Object.keys(CHANNELS).join(', ')}.`
    );
  }
  if (!channel.build) {
    throw new UserFacingError(`${channelName} is not wired up yet.\n\n${channel.pending}`);
  }

  const config = await loadChannelConfig(channelName, undefined, process.env, {
    requireAllowlist: !options.whoami,
  });
  const transport = channel.build({ token: config.token, appToken: config.appToken });

  // One controller for both modes, so Ctrl+C unwinds the poll loop rather than
  // leaving a detached long-poll holding the process open.
  const controller = new AbortController();
  const stop = () => {
    console.log(mutedColor('\nShutting down...'));
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(chalk.bold(`Robin · ${channelName} bridge`));
  console.log(divider());

  if (options.whoami) {
    await runWhoami(transport, controller.signal);
    return;
  }

  // Checked before anything connects: naming a manifest that does not exist
  // grants nothing, so the bridge would run quietly weaker than asked for.
  if (options.manifest) {
    const known = await new AutonomyStore().get(options.manifest);
    if (!known) {
      throw new UserFacingError(
        `No manifest called "${options.manifest}". Run \`robin autonomy list\` to see what there is.`
      );
    }
  }

  const provider = await resolveProvider(options.provider ?? config.provider);
  const model = await resolveModel(provider, options.model ?? config.model);

  // The bridge is a gateway client like the terminal is. Starting one if none
  // is running means `robin serve` works on its own, and joining one that is
  // already up means a terminal and this bridge share live conversations.
  const info = await ensureGateway();
  const client = await GatewayClient.connect({
    port: info.port,
    token: info.token,
    kind: 'channel',
    // A chat client has nobody at a keyboard. Saying so is what makes the
    // gateway route approvals to an attached terminal instead, and refuse them
    // outright when there is none.
    canApprove: false,
    cwd: process.cwd(),
  });
  console.log(mutedColor(`Using the gateway on 127.0.0.1:${info.port}.`));

  const bridge = new ChannelBridge({
    transport,
    client,
    providerId: provider.id,
    model,
    allowlist: config.allow,
    allowTools: options.allowTools,
    manifestId: options.manifest,
  });

  try {
    await bridge.start(controller.signal);
  } finally {
    // The gateway keeps running: a conversation must not end because the
    // bridge did. `robin gateway stop` ends it.
    await client.close();
  }
  console.log(mutedColor('Bridge stopped.'));
}

/** Surfaced in `robin serve --help` so the token variable is discoverable. */
export function serveHelpText(): string {
  return [
    'Channels: telegram, discord and slack (ready), whatsapp and teams (not yet wired up).',
    '',
    'Discord needs the MESSAGE CONTENT intent enabled on your application at',
    'discord.com/developers — without it every message arrives empty and the bot',
    'looks like it is ignoring you.',
    '',
    'Config lives in ~/.robin/channels.json. The bot token may instead come from',
    `an environment variable — ${tokenEnvVar('telegram')}, ${tokenEnvVar('discord')} or`,
    `${tokenEnvVar('slack')}. Slack also needs ${appTokenEnvVar('slack')}.`,
    '',
    'Tool calls that would prompt in the REPL are offered to any terminal attached',
    'to the same gateway, and DENIED when there is none — because then there really',
    'is nobody at a keyboard. --allow-tools runs them unattended instead.',
  ].join('\n');
}
