import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Provider, Message } from '../providers/types.js';
import { parseCommand } from './parse-command.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { printConnectionLine } from '../ui/banner.js';
import { userColor, assistantColor, errorColor, divider, box } from '../ui/theme.js';

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

  printConnectionLine(provider.name, model);
  console.log(chalk.gray('Type your message, /help for commands.'));

  let isFirstTurn = true;

  while (true) {
    if (!isFirstTurn) {
      console.log(divider());
    }
    isFirstTurn = false;

    const line = await rl.question(userColor('> '));
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
      printConnectionLine(provider.name, model);
      continue;
    }

    if (cmd.type === 'provider') {
      provider = await deps.pickProvider();
      model = await deps.pickModel(provider);
      history = [];
      printConnectionLine(provider.name, model);
      continue;
    }

    if (!cmd.arg) continue;

    const historyLengthBeforeTurn = history.length;
    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(assistantColor('» '));
    try {
      const newMessages = await runAgentTurn(provider, model, history, TOOL_DEFINITIONS, {
        onText: (text) => process.stdout.write(text),
        executeTool,
        confirm: async (message) => {
          console.log(`\n${box(message.split('\n'))}`);
          const answer = await rl.question(chalk.yellow('(y/n) '));
          return /^y(es)?$/i.test(answer.trim());
        },
      });
      history.push(...newMessages);
      process.stdout.write('\n');
    } catch (err) {
      // Drop the user message so a failed turn doesn't leave two consecutive
      // user messages in the history sent to the API next time.
      history.length = historyLengthBeforeTurn;
      console.log(errorColor(`\n✖ ${(err as Error).message}`));
    }
  }

  rl.close();
}
