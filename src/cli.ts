#!/usr/bin/env node
import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import type { Provider } from './providers/types.js';
import { listProviders, getProvider } from './providers/index.js';
import { runLogin, runLogout } from './commands/auth-commands.js';
import { runRepl } from './repl/run-repl.js';
import { printBanner } from './ui/banner.js';

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

async function ensureAuthenticated(provider: Provider): Promise<void> {
  if (!(await provider.isAuthenticated())) {
    console.log(`Not logged in to ${provider.name} yet.`);
    await provider.login();
  }
}

async function startChat(providerId?: string): Promise<void> {
  printBanner();
  const provider = providerId ? getProvider(providerId) : await pickProvider();
  await ensureAuthenticated(provider);
  const model = await pickModel(provider);
  await runRepl({ provider, model, pickModel, pickProvider });
}

const program = new Command();
program.name('ai-term-chat').description('Chat with AI models from your terminal');

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
