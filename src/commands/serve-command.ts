import chalk from 'chalk';
import type { Provider } from '../providers/types.js';
import { getProvider, listProviders } from '../providers/index.js';
import { mutedColor, divider } from '../ui/theme.js';
import { loadChannelConfig, tokenEnvVar } from '../channels/config.js';
import { TelegramTransport } from '../channels/telegram.js';
import { ChannelBridge } from '../channels/bridge.js';
import type { ChannelTransport } from '../channels/types.js';
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
 */
const CHANNELS: Record<string, { build?: (token: string) => ChannelTransport; pending?: string }> = {
  telegram: { build: (token) => new TelegramTransport({ token }) },
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

export interface ServeOptions {
  provider?: string;
  model?: string;
  allowTools?: boolean;
  whoami?: boolean;
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
  const transport = channel.build(config.token);

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

  const provider = await resolveProvider(options.provider ?? config.provider);
  const model = await resolveModel(provider, options.model ?? config.model);

  const bridge = new ChannelBridge({
    transport,
    provider,
    model,
    allowlist: config.allow,
    allowTools: options.allowTools,
  });

  await bridge.start(controller.signal);
  console.log(mutedColor('Bridge stopped.'));
}

/** Surfaced in `robin serve --help` so the token variable is discoverable. */
export function serveHelpText(): string {
  return [
    'Channels: telegram (ready), whatsapp and teams (not yet wired up).',
    '',
    'Config lives in ~/.robin/channels.json. The bot token may instead come from',
    `an environment variable — ${tokenEnvVar('telegram')} for Telegram.`,
    '',
    'Tool calls that would prompt in the REPL are DENIED by default, because there',
    'is nobody at the keyboard to approve them. --allow-tools opts in.',
  ].join('\n');
}
