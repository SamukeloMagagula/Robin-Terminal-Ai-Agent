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
import { createSession, buildSystemPrompt } from './session.js';
import { searchChatLogs } from '../recall.js';
import { buildFallbackCandidates, type FallbackCandidate } from './fallback.js';
import { readSlashAwareLine } from './slash-prompt.js';
import { addToInputHistory } from './input-history.js';
import { isModelUnsupported, isProviderQuotaExhausted } from '../providers/chat-error.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { UsageCache } from '../usage/openrouter-usage.js';
import { renderUsageLine, renderUsageReport } from '../usage/render-usage.js';
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
  ['/usage', 'OpenRouter spend for this key, and the account balance'],
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
  // Never reassigned — commands mutate its fields. Task 4's handlers depend on
  // that, since they hold a reference to this object rather than re-reading it.
  const session = createSession(deps.provider, deps.model);
  // Prompt lines, for up/down recall. Session-only; deliberately never
  // persisted, since prompts carry the same sensitive material as transcripts.
  let inputHistory: string[] = [];
  const conversationStore = new ConversationStore();
  const skillStore = new SkillStore();
  const askForApproval = createApprovalGate();
  const usageCache = new UsageCache();
  const unsupportedStore = new UnsupportedModelStore();

  // Fetched before the banner so the figure is on screen from the first
  // frame; null (no key, no network) simply omits the line.
  const startupUsage = await usageCache.get();
  printBanner({
    providerName: session.provider.name,
    model: session.model,
    cwd: process.cwd(),
    sessionId: newSessionId(),
    toolsEnabled: session.toolsEnabled,
    usageLine: startupUsage ? renderUsageLine(startupUsage) : undefined,
  });
  console.log(chalk.gray('Type your message, or / for commands.'));

  let isFirstTurn = true;

  while (true) {
    if (!isFirstTurn) {
      // peek() only — the divider must never wait on the network. The value
      // is refreshed in the background after each turn instead.
      const usage = usageCache.peek();
      console.log(usage ? `${divider()}\n${renderUsageLine(usage)}` : divider());
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
      session.history = [];
      session.chatLog.startNewSession();
      console.log(chalk.gray('Conversation cleared.'));
      continue;
    }

    if (cmd.type === 'model') {
      session.model = await deps.pickModel(session.provider);
      session.history = [];
      session.chatLog.startNewSession();
      printConnectionLine(session.provider.name, session.model);
      continue;
    }

    if (cmd.type === 'provider') {
      const picked = await deps.pickProviderAndModel();
      session.provider = picked.provider;
      session.model = picked.model;
      session.history = [];
      session.chatLog.startNewSession();
      printConnectionLine(session.provider.name, session.model);
      continue;
    }

    if (cmd.type === 'usage') {
      const usage = await usageCache.get();
      console.log(
        usage
          ? renderUsageReport(usage)
          : mutedColor(
              'No OpenRouter usage available — run `robin login openrouter`, or check your connection.'
            )
      );
      continue;
    }

    if (cmd.type === 'random') {
      // A re-roll is a provider switch, so it resets history and starts a new
      // transcript exactly like /model and /provider do.
      try {
        const rolled = await deps.rollRandom();
        session.provider = rolled.provider;
        session.model = rolled.model;
        session.history = [];
        session.chatLog.startNewSession();
        printConnectionLine(session.provider.name, session.model);
      } catch (err) {
        console.log(errorColor(`✖ ${(err as Error).message}`));
      }
      continue;
    }

    if (cmd.type === 'system') {
      if (!cmd.arg) {
        console.log(
          session.systemPrompt
            ? mutedColor(session.systemPrompt)
            : mutedColor('No system prompt set. Usage: /system <text>  or  /system clear')
        );
        console.log(mutedColor(`\nAlways sent:\n${environmentPrompt()}`));
      } else if (cmd.arg === 'clear') {
        session.systemPrompt = undefined;
        console.log(chalk.gray('System prompt cleared.'));
      } else {
        session.systemPrompt = cmd.arg;
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
        session.toolsEnabled = !session.toolsEnabled;
        console.log(chalk.gray(`Tools ${session.toolsEnabled ? 'enabled' : 'disabled'}.`));
      }
      continue;
    }

    if (cmd.type === 'copy') {
      const lastReply = [...session.history]
        .reverse()
        .find((m) => m.role === 'assistant' && m.content);
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
        } else if (!session.systemPrompt) {
          console.log(errorColor('✖ No system prompt set. Set one with /system <text> first.'));
        } else {
          try {
            await skillStore.save(name, {
              prompt: session.systemPrompt,
              savedAt: new Date().toISOString(),
            });
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
            session.systemPrompt = skill.prompt;
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
        session.history.push({
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
          providerId: session.provider.id,
          providerName: session.provider.name,
          model: session.model,
          savedAt: new Date().toISOString(),
          messages: session.history,
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
        session.history = saved.messages;
        session.chatLog.startNewSession();
        console.log(
          chalk.gray(`Loaded conversation "${cmd.arg}" (saved on ${saved.providerName} · ${saved.model}).`)
        );
      } catch (err) {
        console.log(errorColor(`✖ Could not load "${cmd.arg}": ${(err as Error).message}`));
      }
      continue;
    }

    if (!cmd.arg) continue;

    const historyLengthBeforeTurn = session.history.length;
    session.history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(assistantColor('» '));

    let activeProvider = session.provider;
    let activeModel = session.model;
    let fallbackCandidates: FallbackCandidate[] | undefined;
    let fallbackIndex = 0;
    let lastError: Error | undefined;
    // Providers that refused this turn on quota. Reset per turn, because a
    // rate-limit window can reopen between messages.
    const quotaBlocked = new Set<string>();
    let succeeded = false;

    while (true) {
      try {
        const messagesForTurn: Message[] = [
          { role: 'system', content: buildSystemPrompt(session) },
          ...session.history,
        ];
        const newMessages = await runAgentTurn(
          activeProvider,
          activeModel,
          messagesForTurn,
          session.toolsEnabled ? TOOL_DEFINITIONS : [],
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
        session.history.push(...newMessages);
        process.stdout.write('\n');
        succeeded = true;
        break;
      } catch (err) {
        lastError = err as Error;
        // A model the provider says it does not support will never work, so
        // remember it and drop every other candidate on that provider that is
        // already known-bad, instead of retrying into the same wall.
        if (isModelUnsupported(err)) {
          await unsupportedStore.record(activeProvider.id, activeModel);
        }
        // A quota refusal is about the account, not the model, so every sibling
        // model on that provider will refuse identically. Skip the rest of them
        // rather than printing the same rate-limit message five times.
        if (isProviderQuotaExhausted(err)) {
          quotaBlocked.add(activeProvider.id);
        }
        if (!fallbackCandidates) {
          fallbackCandidates = await buildFallbackCandidates(activeProvider, activeModel, listProviders());
        }
        while (
          fallbackIndex < fallbackCandidates.length &&
          quotaBlocked.has(fallbackCandidates[fallbackIndex].provider.id)
        ) {
          fallbackIndex++;
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
      if (activeProvider.id !== session.provider.id || activeModel !== session.model) {
        session.provider = activeProvider;
        session.model = activeModel;
        printConnectionLine(session.provider.name, session.model);
      }
      await session.chatLog.write(session.provider.name, session.model, session.history);
      // Refresh in the background so the next divider has a fresh figure
      // without the user ever waiting on it. Failures are already swallowed
      // inside the cache; the catch is belt-and-braces against an unhandled
      // rejection taking down the process.
      void usageCache.get().catch(() => {});
    } else {
      // Drop the user message so a failed turn doesn't leave two consecutive
      // user messages in the history sent to the API next time.
      session.history.length = historyLengthBeforeTurn;
      console.log(errorColor(`\n✖ ${lastError?.message}`));
    }
  }
}
