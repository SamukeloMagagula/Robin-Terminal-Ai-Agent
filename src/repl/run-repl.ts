import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Provider, Message } from '../providers/types.js';
import { listProviders } from '../providers/index.js';
import { parseCommand } from './parse-command.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { printConnectionLine } from '../ui/banner.js';
import { ConversationStore } from '../conversation-store.js';
import { SkillStore } from '../skill-store.js';
import { copyToClipboard } from '../clipboard.js';
import { ChatLog } from '../chat-log.js';
import { buildFallbackCandidates, type FallbackCandidate } from './fallback.js';
import {
  assistantColor,
  errorColor,
  mutedColor,
  divider,
  box,
  USER_INPUT_COLOR,
  RESET_COLOR,
} from '../ui/theme.js';

export interface ReplDeps {
  provider: Provider;
  model: string;
  pickModel: (provider: Provider) => Promise<string>;
  pickProvider: () => Promise<Provider>;
  pickProviderAndModel: () => Promise<{ provider: Provider; model: string }>;
}

const HELP_ENTRIES: [string, string][] = [
  ['/help', 'list commands'],
  ['/model', 'switch model on the current provider'],
  ['/provider', 'switch provider (e.g. Copilot ↔ Ollama) — pick "← Back" in the model list to change your mind'],
  ['/system [text]', 'view, set, or "/system clear" the system prompt'],
  ['/tools [list]', 'toggle tool-calling on/off, or list available tools'],
  ['/save [name]', 'save the conversation, or list saved ones'],
  ['/load [name]', 'load a saved conversation, or list saved ones'],
  ['/copy', "copy the assistant's last reply to the clipboard"],
  ['/skill save <name>', 'save the current system prompt as a reusable named preset'],
  ['/skill use <name>', 'load a saved preset as the system prompt'],
  ['/skill [list]', 'list saved presets'],
  ['/clear', 'reset the conversation'],
  ['/exit', 'quit'],
];

function printHelp(): void {
  for (const [name, description] of HELP_ENTRIES) {
    console.log(`  ${assistantColor(name.padEnd(20))}${mutedColor(description)}`);
  }
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  let provider = deps.provider;
  let model = deps.model;
  let history: Message[] = [];
  let systemPrompt: string | undefined;
  let toolsEnabled = true;
  const conversationStore = new ConversationStore();
  const skillStore = new SkillStore();
  const chatLog = new ChatLog();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  printConnectionLine(provider.name, model);
  console.log(chalk.gray('Commands:'));
  printHelp();

  let isFirstTurn = true;

  while (true) {
    if (!isFirstTurn) {
      console.log(divider());
    }
    isFirstTurn = false;

    const line = await rl.question(`${USER_INPUT_COLOR}> `);
    process.stdout.write(RESET_COLOR);
    const cmd = parseCommand(line);

    if (cmd.type === 'exit') break;

    if (cmd.type === 'unknown') {
      console.log(errorColor(`✖ Unknown command: ${cmd.arg}. Type /help for commands.`));
      continue;
    }

    if (cmd.type === 'help') {
      printHelp();
      continue;
    }

    if (cmd.type === 'clear') {
      history = [];
      chatLog.startNewSession();
      console.log(chalk.gray('Conversation cleared.'));
      continue;
    }

    if (cmd.type === 'model') {
      model = await deps.pickModel(provider);
      // @inquirer/prompts closes its own internal readline.Interface on the
      // shared process.stdin when a prompt finishes, which pauses the stream
      // at the OS/stream level. Our own readline.Interface (created once,
      // above) doesn't know that happened — its own .resume() is a no-op
      // because its internal `paused` flag was never set — so without this,
      // the next rl.question() would await input that never arrives and the
      // process would exit silently once nothing else keeps the loop alive.
      process.stdin.resume();
      history = [];
      chatLog.startNewSession();
      printConnectionLine(provider.name, model);
      continue;
    }

    if (cmd.type === 'provider') {
      const picked = await deps.pickProviderAndModel();
      process.stdin.resume();
      provider = picked.provider;
      model = picked.model;
      history = [];
      chatLog.startNewSession();
      printConnectionLine(provider.name, model);
      continue;
    }

    if (cmd.type === 'system') {
      if (!cmd.arg) {
        console.log(
          systemPrompt
            ? mutedColor(systemPrompt)
            : mutedColor('No system prompt set. Usage: /system <text>  or  /system clear')
        );
      } else if (cmd.arg === 'clear') {
        systemPrompt = undefined;
        console.log(chalk.gray('System prompt cleared.'));
      } else {
        systemPrompt = cmd.arg;
        console.log(chalk.gray('System prompt set.'));
      }
      continue;
    }

    if (cmd.type === 'tools') {
      if (cmd.arg === 'list') {
        for (const tool of TOOL_DEFINITIONS) {
          console.log(`  ${assistantColor(tool.name.padEnd(14))}${mutedColor(tool.description)}`);
        }
      } else {
        toolsEnabled = !toolsEnabled;
        console.log(chalk.gray(`Tools ${toolsEnabled ? 'enabled' : 'disabled'}.`));
      }
      continue;
    }

    if (cmd.type === 'copy') {
      const lastReply = [...history].reverse().find((m) => m.role === 'assistant' && m.content);
      if (!lastReply) {
        console.log(chalk.gray('Nothing to copy yet.'));
      } else {
        try {
          await copyToClipboard(lastReply.content);
          console.log(chalk.gray('Copied last reply to clipboard.'));
        } catch (err) {
          console.log(errorColor(`✖ Could not copy to clipboard: ${(err as Error).message}`));
        }
      }
      continue;
    }

    if (cmd.type === 'skill') {
      const [sub, ...rest] = (cmd.arg ?? '').split(' ').filter(Boolean);
      const name = rest.join(' ');

      if (!sub || sub === 'list') {
        const names = await skillStore.list();
        console.log(
          names.length
            ? mutedColor(names.join(', '))
            : mutedColor('No saved skills yet. Usage: /skill save <name>')
        );
      } else if (sub === 'save') {
        if (!name) {
          console.log(errorColor('✖ Usage: /skill save <name>'));
        } else if (!systemPrompt) {
          console.log(errorColor('✖ No system prompt set. Set one with /system <text> first.'));
        } else {
          try {
            await skillStore.save(name, { prompt: systemPrompt, savedAt: new Date().toISOString() });
            console.log(chalk.gray(`Saved skill "${name}".`));
          } catch (err) {
            console.log(errorColor(`✖ ${(err as Error).message}`));
          }
        }
      } else if (sub === 'use') {
        if (!name) {
          console.log(errorColor('✖ Usage: /skill use <name>'));
        } else {
          try {
            const skill = await skillStore.load(name);
            systemPrompt = skill.prompt;
            console.log(chalk.gray(`Using skill "${name}".`));
          } catch (err) {
            console.log(errorColor(`✖ Could not load "${name}": ${(err as Error).message}`));
          }
        }
      } else {
        console.log(errorColor(`✖ Unknown /skill subcommand "${sub}". Usage: /skill save|use|list [name]`));
      }
      continue;
    }

    if (cmd.type === 'save') {
      if (!cmd.arg) {
        const names = await conversationStore.list();
        console.log(
          names.length
            ? mutedColor(names.join(', '))
            : mutedColor('No saved conversations yet. Usage: /save <name>')
        );
        continue;
      }
      try {
        await conversationStore.save(cmd.arg, {
          providerId: provider.id,
          providerName: provider.name,
          model,
          savedAt: new Date().toISOString(),
          messages: history,
        });
        console.log(chalk.gray(`Saved conversation as "${cmd.arg}".`));
      } catch (err) {
        console.log(errorColor(`✖ ${(err as Error).message}`));
      }
      continue;
    }

    if (cmd.type === 'load') {
      if (!cmd.arg) {
        const names = await conversationStore.list();
        console.log(
          names.length
            ? mutedColor(names.join(', '))
            : mutedColor('No saved conversations yet. Usage: /load <name>')
        );
        continue;
      }
      try {
        const saved = await conversationStore.load(cmd.arg);
        history = saved.messages;
        chatLog.startNewSession();
        console.log(
          chalk.gray(`Loaded conversation "${cmd.arg}" (saved on ${saved.providerName} · ${saved.model}).`)
        );
      } catch (err) {
        console.log(errorColor(`✖ Could not load "${cmd.arg}": ${(err as Error).message}`));
      }
      continue;
    }

    if (!cmd.arg) continue;

    const historyLengthBeforeTurn = history.length;
    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(assistantColor('» '));

    let activeProvider = provider;
    let activeModel = model;
    let fallbackCandidates: FallbackCandidate[] | undefined;
    let fallbackIndex = 0;
    let lastError: Error | undefined;
    let succeeded = false;

    while (true) {
      try {
        const messagesForTurn: Message[] = systemPrompt
          ? [{ role: 'system', content: systemPrompt }, ...history]
          : history;
        const newMessages = await runAgentTurn(
          activeProvider,
          activeModel,
          messagesForTurn,
          toolsEnabled ? TOOL_DEFINITIONS : [],
          {
            onText: (text) => process.stdout.write(text),
            executeTool,
            confirm: async (message) => {
              console.log(`\n${box(message.split('\n'))}`);
              while (true) {
                const answer = (await rl.question(chalk.yellow('(y/n) '))).trim();
                if (/^y(es)?$/i.test(answer)) return true;
                if (/^n(o)?$/i.test(answer)) return false;
                console.log(mutedColor('Please answer y or n.'));
              }
            },
          }
        );
        history.push(...newMessages);
        process.stdout.write('\n');
        succeeded = true;
        break;
      } catch (err) {
        lastError = err as Error;
        if (!fallbackCandidates) {
          fallbackCandidates = await buildFallbackCandidates(activeProvider, activeModel, listProviders());
        }
        if (fallbackIndex >= fallbackCandidates.length) break;
        const next = fallbackCandidates[fallbackIndex];
        fallbackIndex++;
        console.log(mutedColor(`\n  ${lastError.message} — trying ${next.provider.name} · ${next.model}...`));
        activeProvider = next.provider;
        activeModel = next.model;
        process.stdout.write(assistantColor('» '));
      }
    }

    if (succeeded) {
      if (activeProvider.id !== provider.id || activeModel !== model) {
        provider = activeProvider;
        model = activeModel;
        printConnectionLine(provider.name, model);
      }
      await chatLog.write(provider.name, model, history);
    } else {
      // Drop the user message so a failed turn doesn't leave two consecutive
      // user messages in the history sent to the API next time.
      history.length = historyLengthBeforeTurn;
      console.log(errorColor(`\n✖ ${lastError?.message}`));
    }
  }

  rl.close();
}
