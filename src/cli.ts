#!/usr/bin/env node
import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import type { Provider } from './providers/types.js';
import { listProviders, getProvider } from './providers/index.js';
import { runLogin, runLogout } from './commands/auth-commands.js';
import { runStatus } from './commands/status-command.js';
import { runRepl } from './repl/run-repl.js';

async function pickProvider(): Promise<Provider> {
  const id = await select({
    message: 'Select a provider:',
    choices: listProviders().map((p) => ({ name: p.name, value: p.id })),
  });
  return getProvider(id);
}

async function pickModel(provider: Provider): Promise<string> {
  const models = await provider.listModels();
  return select({
    message: 'Select a model:',
    choices: models.map((m) => ({ name: m, value: m })),
  });
}

const BACK = '__back__';

/** Same as pickModel, but with a "← Back" choice for returning to provider selection. */
async function pickModelWithBack(provider: Provider): Promise<string> {
  const models = await provider.listModels();
  return select({
    message: 'Select a model:',
    choices: [{ name: '← Back to provider list', value: BACK }, ...models.map((m) => ({ name: m, value: m }))],
  });
}

async function ensureAuthenticated(provider: Provider): Promise<void> {
  if (!(await provider.isAuthenticated())) {
    console.log(`Not logged in to ${provider.name} yet.`);
    await provider.login();
  }
}

/** Picks a provider, then a model — looping back to provider selection if the model picker's "Back" choice is taken. */
async function pickProviderAndModel(): Promise<{ provider: Provider; model: string }> {
  let provider = await pickProvider();
  while (true) {
    await ensureAuthenticated(provider);
    const modelChoice = await pickModelWithBack(provider);
    if (modelChoice === BACK) {
      provider = await pickProvider();
      continue;
    }
    return { provider, model: modelChoice };
  }
}

async function startChat(providerId?: string): Promise<void> {
  if (providerId) {
    const provider = getProvider(providerId);
    await ensureAuthenticated(provider);
    const model = await pickModel(provider);
    await runRepl({ provider, model, pickModel, pickProvider, pickProviderAndModel });
    return;
  }
  const { provider, model } = await pickProviderAndModel();
  await runRepl({ provider, model, pickModel, pickProvider, pickProviderAndModel });
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
  .description('Start a chat session')
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
