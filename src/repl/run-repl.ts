import chalk from 'chalk';
import { expand } from '@inquirer/prompts';
import type { Provider, Message } from '../providers/types.js';
import { listProviders } from '../providers/index.js';
import { parseCommand } from './parse-command.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool, wrapUntrusted, type ConfirmRequest } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { printBanner, printConnectionLine } from '../ui/banner.js';
import { newSessionId } from '../session-id.js';
import { environmentPrompt } from '../environment-prompt.js';
import { ConversationStore } from '../conversation-store.js';
import { SkillStore } from '../skill-store.js';
import { copyToClipboard } from '../clipboard.js';
import { ChatLog } from '../chat-log.js';
import { searchChatLogs } from '../recall.js';
import { buildFallbackCandidates, type FallbackCandidate } from './fallback.js';
import { readSlashAwareLine } from './slash-prompt.js';
import { addToInputHistory } from './input-history.js';
import { assistantColor, errorColor, mutedColor, divider, box } from '../ui/theme.js';

export interface ReplDeps {
  provider: Provider;
  model: string;
  pickModel: (provider: Provider) => Promise<string>;
  pickProviderAndModel: () => Promise<{ provider: Provider; model: string }>;
  /** Re-rolls a random provider/model pair, announcing what it landed on. */
  rollRandom: () => Promise<{ provider: Provider; model: string }>;
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
  ['/random', 'switch to a randomly chosen provider and model'],
  ['/recall <query>', 'search past conversations under ~/.robin/chats/'],
  ['/clear', 'reset the conversation'],
  ['/exit', 'quit'],
];

const APPROVAL_WORDING: Record<ConfirmRequest['kind'], { question: string; scope: string }> = {
  run_command: { question: 'Run it?', scope: 'commands' },
  write_file: { question: 'Write it?', scope: 'file writes' },
  read_file: { question: 'Read it?', scope: 'reads outside this directory' },
};

/**
 * Approval gate for one session. Remembering a decision per *kind* is what
 * makes this bearable: a model exploring a project issues a stream of
 * near-identical requests, and being asked about each one individually trains
 * the user to approve without reading — the opposite of what the gate is for.
 */
function createApprovalGate(): (request: ConfirmRequest) => Promise<boolean> {
  const alwaysAllow = new Set<ConfirmRequest['kind']>();

  return async (request: ConfirmRequest): Promise<boolean> => {
    if (alwaysAllow.has(request.kind)) return true;

    const { question, scope } = APPROVAL_WORDING[request.kind];
    console.log(`\n${box(request.message.split('\n'))}`);
    const answer = await expand<'yes' | 'no' | 'always'>({
      message: question,
      default: 'n',
      choices: [
        { key: 'y', name: 'yes, this once', value: 'yes' },
        { key: 'n', name: 'no', value: 'no' },
        { key: 'a', name: `yes, and stop asking about ${scope} this session`, value: 'always' },
      ],
    });

    if (answer === 'always') {
      alwaysAllow.add(request.kind);
      console.log(mutedColor(`Will not ask about ${scope} again until you restart Robin.`));
      return true;
    }
    return answer === 'yes';
  };
}

function printHelp(): void {
  for (const [name, description] of HELP_ENTRIES) {
    console.log(`  ${assistantColor(name.padEnd(20))}${mutedColor(description)}`);
  }
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  let provider = deps.provider;
  let model = deps.model;
  let history: Message[] = [];
  // Prompt lines, for up/down recall. Session-only; deliberately never
  // persisted, since prompts carry the same sensitive material as transcripts.
  let inputHistory: string[] = [];
  let systemPrompt: string | undefined;
  let toolsEnabled = true;
  const conversationStore = new ConversationStore();
  const skillStore = new SkillStore();
  const chatLog = new ChatLog();
  const askForApproval = createApprovalGate();

  printBanner({
    providerName: provider.name,
    model,
    cwd: process.cwd(),
    sessionId: newSessionId(),
    toolsEnabled,
  });
  console.log(chalk.gray('Type your message, or / for commands.'));

  let isFirstTurn = true;

  while (true) {
    if (!isFirstTurn) {
      console.log(divider());
    }
    isFirstTurn = false;

    // `inputHistory` is what the user typed at the prompt; `history` above is
    // the conversation sent to the model. Distinct names on purpose.
    const line = await readSlashAwareLine(inputHistory);
    inputHistory = addToInputHistory(inputHistory, line);
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
      history = [];
      chatLog.startNewSession();
      printConnectionLine(provider.name, model);
      continue;
    }

    if (cmd.type === 'provider') {
      const picked = await deps.pickProviderAndModel();
      provider = picked.provider;
      model = picked.model;
      history = [];
      chatLog.startNewSession();
      printConnectionLine(provider.name, model);
      continue;
    }

    if (cmd.type === 'random') {
      // A re-roll is a provider switch, so it resets history and starts a new
      // transcript exactly like /model and /provider do.
      try {
        const rolled = await deps.rollRandom();
        provider = rolled.provider;
        model = rolled.model;
        history = [];
        chatLog.startNewSession();
        printConnectionLine(provider.name, model);
      } catch (err) {
        console.log(errorColor(`✖ ${(err as Error).message}`));
      }
      continue;
    }

    if (cmd.type === 'system') {
      if (!cmd.arg) {
        console.log(
          systemPrompt
            ? mutedColor(systemPrompt)
            : mutedColor('No system prompt set. Usage: /system <text>  or  /system clear')
        );
        console.log(mutedColor(`\nAlways sent:\n${environmentPrompt()}`));
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

    if (cmd.type === 'recall') {
      if (!cmd.arg) {
        console.log(errorColor('✖ Usage: /recall <query>'));
        continue;
      }
      const matches = await searchChatLogs(cmd.arg);
      if (matches.length === 0) {
        console.log(mutedColor(`No matches for "${cmd.arg}" in ~/.robin/chats/.`));
      } else {
        for (const match of matches) {
          console.log(`  ${assistantColor(match.file)}${mutedColor(`:${match.lineNumber}`)}`);
          for (const line of match.context) {
            console.log(`    ${mutedColor(line)}`);
          }
          console.log();
        }
        // Add to the conversation (not just the terminal) so a follow-up like
        // "yep that one" has something for the model to actually refer to.
        const recalled = matches.map((m) => `[${m.file}:${m.lineNumber}]\n${m.context.join('\n')}`).join('\n\n');
        // Transcripts contain past tool output — file contents and command
        // output that were wrapped as untrusted the first time round. Replaying
        // them as a plain user message would launder that text back into the
        // context as if the user had typed it, so re-wrap it.
        history.push({
          role: 'user',
          content: wrapUntrusted(
            `recalled excerpts from past conversations matching "${cmd.arg}"`,
            recalled
          ),
        });
        console.log(mutedColor('(Added to the conversation — you can refer to it in your next message.)'));
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
        // The environment preamble is always sent, and always first: /system
        // controls the user's own instructions, not what Robin knows about
        // the machine it is running on.
        const systemContent = systemPrompt
          ? `${environmentPrompt()}\n\n${systemPrompt}`
          : environmentPrompt();
        const messagesForTurn: Message[] = [
          { role: 'system', content: systemContent },
          ...history,
        ];
        const newMessages = await runAgentTurn(
          activeProvider,
          activeModel,
          messagesForTurn,
          toolsEnabled ? TOOL_DEFINITIONS : [],
          {
            onText: (text) => process.stdout.write(text),
            executeTool: (toolCall, confirm) =>
              executeTool(toolCall, confirm, {
                // Read-only commands run unannounced otherwise; showing them
                // keeps the user aware of what Robin actually did.
                onAutoApproved: (command) => console.log(mutedColor(`\n  $ ${command}`)),
              }),
            confirm: askForApproval,
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
}
