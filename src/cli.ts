#!/usr/bin/env node
import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import type { Provider } from './providers/types.js';
import { listProviders, getProvider } from './providers/index.js';
import { runLogin, runLogout } from './commands/auth-commands.js';
import { runStatus } from './commands/status-command.js';
import { runRepl } from './repl/run-repl.js';
import { pickRandomProviderAndModel } from './random-pick.js';
import { pickFromChoices, toChoices } from './ui/model-picker.js';

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

async function startChat(providerId?: string): Promise<void> {
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

program
  .command('chat [provider]')
  .description('Start a chat session — pass a provider id, or "random" to roll one')
  .action(async (providerId?: string) => {
    await startChat(providerId);
  });

program.action(async () => {
  await startChat();
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
