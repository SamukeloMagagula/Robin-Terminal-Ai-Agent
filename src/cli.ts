#!/usr/bin/env node
import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import type { Provider } from './providers/types.js';
import { listProviders, getProvider } from './providers/index.js';
import { runLogin, runLogout } from './commands/auth-commands.js';
import { runStatus } from './commands/status-command.js';
import { runModelsList, runModelsForget } from './commands/models-command.js';
import { runRepl } from './repl/run-repl.js';
import { runDoctor } from './commands/doctor-command.js';
import {
  runGatewayStart,
  runGatewayStop,
  runGatewayStatus,
} from './commands/gateway-command.js';
import { runServe, serveHelpText, type ServeOptions } from './commands/serve-command.js';
import { pickRandomProviderAndModel } from './random-pick.js';
import { pickFromChoices, toChoices } from './ui/model-picker.js';
import { mutedColor, errorColor } from './ui/theme.js';
import {
  installGlobalErrorHandlers,
  reportFatal,
  requireInteractiveTerminal,
} from './startup/bootstrap.js';
import { buildChecks, runChecks, blockingFailures } from './startup/preflight.js';

const RANDOM = '__random__';

/**
 * A provider chosen from the menu still needs a model picked; a random roll
 * already has one. Keeping them distinct stops the roll's model being
 * announced and then thrown away by the model picker.
 */
type ProviderChoice =
  | { kind: 'chosen'; provider: Provider }
  | { kind: 'rolled'; provider: Provider; model: string };

async function rollRandom(): Promise<{ provider: Provider; model: string }> {
  const choice = await pickRandomProviderAndModel(listProviders());
  // A random pick the user can't see leaves them unable to judge the reply.
  console.log(`🎲 Rolled ${choice.provider.name} · ${choice.model}`);
  return choice;
}

async function chooseProvider(): Promise<ProviderChoice> {
  const id = await select({
    message: 'Select a provider:',
    choices: [
      { name: '🎲 Random', value: RANDOM },
      ...listProviders().map((p) => ({ name: p.name, value: p.id })),
    ],
  });
  if (id === RANDOM) return { kind: 'rolled', ...(await rollRandom()) };
  return { kind: 'chosen', provider: getProvider(id) };
}

async function pickModel(provider: Provider): Promise<string> {
  const models = await provider.listModels();
  return pickFromChoices('Select a model:', toChoices(models));
}

const BACK = '__back__';

/** Same as pickModel, but with a "← Back" choice for returning to provider selection. */
async function pickModelWithBack(provider: Provider): Promise<string> {
  const models = await provider.listModels();
  return pickFromChoices('Select a model:', toChoices(models), [
    { name: '← Back to provider list', value: BACK },
  ]);
}

async function ensureAuthenticated(provider: Provider): Promise<void> {
  if (!(await provider.isAuthenticated())) {
    console.log(`Not logged in to ${provider.name} yet.`);
    await provider.login();
  }
}

/** Picks a provider, then a model — looping back to provider selection if the model picker's "Back" choice is taken. */
async function pickProviderAndModel(): Promise<{ provider: Provider; model: string }> {
  let choice = await chooseProvider();
  while (true) {
    // A rolled pair is already complete, and the roll only considers providers
    // that are authenticated, so there is nothing left to ask.
    if (choice.kind === 'rolled') {
      return { provider: choice.provider, model: choice.model };
    }
    await ensureAuthenticated(choice.provider);
    const modelChoice = await pickModelWithBack(choice.provider);
    if (modelChoice === BACK) {
      choice = await chooseProvider();
      continue;
    }
    return { provider: choice.provider, model: modelChoice };
  }
}

/**
 * The gate every interactive session passes through.
 *
 * Only the critical checks abort — a stale native module or an unwritable
 * config directory means nothing downstream will work, and finding that out
 * six screens later as a stack trace is what "I can't run this" looks like.
 * Non-critical findings are deliberately not printed here: a clean start
 * should be silent, and `robin doctor` exists for the full picture.
 */
async function preflightOrExit(): Promise<void> {
  const results = await runChecks(buildChecks({ providers: listProviders() }));
  const blocking = blockingFailures(results);
  if (blocking.length === 0) return;

  console.error(errorColor('✖ Robin cannot start:'));
  for (const failure of blocking) {
    console.error(errorColor(`  ${failure.label}: ${failure.detail}`));
    if (failure.remedy) console.error(mutedColor(`    → ${failure.remedy}`));
  }
  console.error(mutedColor('\nRun `robin doctor` for the full report.'));
  process.exit(1);
}

async function startChat(providerId?: string): Promise<void> {
  requireInteractiveTerminal();
  await preflightOrExit();

  if (providerId === 'random') {
    const { provider, model } = await rollRandom();
    await runRepl({ provider, model, pickModel, pickProviderAndModel, rollRandom });
    return;
  }
  if (providerId) {
    const provider = getProvider(providerId);
    await ensureAuthenticated(provider);
    const model = await pickModel(provider);
    await runRepl({ provider, model, pickModel, pickProviderAndModel, rollRandom });
    return;
  }
  const { provider, model } = await pickProviderAndModel();
  await runRepl({ provider, model, pickModel, pickProviderAndModel, rollRandom });
}

const program = new Command();
program.name('robin').description('Chat with AI models from your terminal');

program
  .command('login <provider>')
  .description('Log in to a provider')
  .action(async (providerId: string) => {
    await runLogin(getProvider(providerId));
  });

program
  .command('logout <provider>')
  .description('Log out of a provider')
  .action(async (providerId: string) => {
    await runLogout(getProvider(providerId));
  });

program
  .command('status')
  .description('Show login/reachability status for every provider')
  .action(async () => {
    await runStatus(listProviders());
  });

const models = program
  .command('models')
  .description('Inspect models Robin has recorded as unsupported');

models
  .command('list', { isDefault: true })
  .description('List models recorded as unsupported, per provider')
  .action(async () => {
    await runModelsList(listProviders());
  });

models
  .command('forget <provider>')
  .description('Forget a provider’s unsupported-model records so they are offered again')
  .action(async (providerId: string) => {
    await runModelsForget(getProvider(providerId));
  });

program
  .command('serve <channel>')
  .description('Run Robin as a bridge so it can be driven from a messaging app')
  .option('-p, --provider <id>', 'provider to answer with (default: first logged in)')
  .option('-m, --model <model>', 'model to answer with')
  .option('--allow-tools', 'let tool calls run without approval — see the warning below', false)
  .option('--whoami', 'print the sender id of anyone who messages the bot, then exit', false)
  .addHelpText('after', `\n${serveHelpText()}`)
  .action(async (channel: string, options: ServeOptions) => {
    await runServe(channel, options);
  });

const gateway = program
  .command('gateway')
  .description('The local control plane that owns sessions. `robin chat` starts one for you');

gateway
  .command('status', { isDefault: true })
  .description('Report whether a gateway is running, and where')
  .action(async () => {
    await runGatewayStatus();
  });

gateway
  .command('start')
  .description('Run the gateway in the foreground')
  .action(async () => {
    await runGatewayStart();
  });

gateway
  .command('stop')
  .description('Stop the running gateway')
  .action(async () => {
    await runGatewayStop();
  });

program
  .command('doctor')
  .description('Check this installation and report anything that would stop Robin starting')
  .action(async () => {
    await runDoctor(listProviders());
  });

program
  .command('chat [provider]')
  .description('Start a chat session — pass a provider id, or "random" to roll one')
  .action(async (providerId?: string) => {
    await startChat(providerId);
  });

program.action(async () => {
  await startChat();
});

installGlobalErrorHandlers();

program.parseAsync(process.argv).catch(reportFatal);
