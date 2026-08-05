import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Provider, Message } from '../providers/types.js';
import { parseCommand } from './parse-command.js';

export interface ReplDeps {
  provider: Provider;
  model: string;
  pickModel: (provider: Provider) => Promise<string>;
  pickProvider: () => Promise<Provider>;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  let provider = deps.provider;
  let model = deps.model;
  let history: Message[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.cyan(`Connected to ${provider.name} (${model}). Type your message, /help for commands.`));

  while (true) {
    const line = await rl.question('> ');
    const cmd = parseCommand(line);

    if (cmd.type === 'exit') break;

    if (cmd.type === 'help') {
      console.log('/help, /exit, /clear, /model, /provider');
      continue;
    }

    if (cmd.type === 'clear') {
      history = [];
      console.log(chalk.gray('Conversation cleared.'));
      continue;
    }

    if (cmd.type === 'model') {
      model = await deps.pickModel(provider);
      history = [];
      continue;
    }

    if (cmd.type === 'provider') {
      provider = await deps.pickProvider();
      model = await deps.pickModel(provider);
      history = [];
      continue;
    }

    if (!cmd.arg) continue;

    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(chalk.magenta('assistant> '));
    let reply = '';
    try {
      for await (const chunk of provider.chat(model, history)) {
        process.stdout.write(chunk);
        reply += chunk;
      }
      process.stdout.write('\n');
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      console.log(chalk.red(`\nError: ${(err as Error).message}`));
    }
  }

  rl.close();
}
