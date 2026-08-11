import chalk from 'chalk';
import { expand } from '@inquirer/prompts';
import type { Provider } from '../providers/types.js';
import { parseCommand, type ParsedCommand } from './parse-command.js';
import { type ConfirmRequest } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { printBanner, printConnectionLine } from '../ui/banner.js';
import { newSessionId } from '../session-id.js';
import { environmentPrompt } from '../environment-prompt.js';
import { ConversationStore } from '../conversation-store.js';
import { SkillStore } from '../skill-store.js';
import { createSession } from './session.js';
import { runTurn } from './run-turn.js';
import { readSlashAwareLine } from './slash-prompt.js';
import { addToInputHistory } from './input-history.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { UsageCache } from '../usage/openrouter-usage.js';
import { renderUsageLine } from '../usage/render-usage.js';
import { assistantColor, errorColor, mutedColor, divider, box } from '../ui/theme.js';
import {
  type ReplContext,
  type CommandHandler,
  handleHelp,
  handleUsage,
  handleRecall,
  handleClear,
  handleCopy,
  handleSkill,
  handleSave,
  handleLoad,
} from './commands/index.js';

export interface ReplDeps {
  provider: Provider;
  model: string;
  pickModel: (provider: Provider) => Promise<string>;
  pickProviderAndModel: () => Promise<{ provider: Provider; model: string }>;
  /** Re-rolls a random provider/model pair, announcing what it landed on. */
  rollRandom: () => Promise<{ provider: Provider; model: string }>;
}

/**
 * Commands that are wholly handled by a module under ./commands/. Anything
 * absent here still falls through to the inline branches below.
 */
const HANDLERS: Partial<Record<ParsedCommand['type'], CommandHandler>> = {
  help: handleHelp,
  usage: handleUsage,
  recall: handleRecall,
  clear: handleClear,
  copy: handleCopy,
  skill: handleSkill,
  save: handleSave,
  load: handleLoad,
};

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

  // Built once. `session` is never reassigned — commands mutate its fields —
  // so this reference stays correct for the life of the loop.
  const ctx: ReplContext = {
    session,
    inputHistory,
    stores: {
      conversation: conversationStore,
      skill: skillStore,
      unsupported: unsupportedStore,
      usage: usageCache,
    },
    confirm: askForApproval,
  };

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

    const handler = HANDLERS[cmd.type];
    if (handler) {
      await handler(ctx, cmd.arg);
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

    if (!cmd.arg) continue;

    process.stdout.write(assistantColor('» '));
    const result = await runTurn(session, cmd.arg, {
      onText: (text) => process.stdout.write(text),
      confirm: askForApproval,
      unsupportedStore,
      // Read-only commands run unannounced otherwise; showing them keeps the
      // user aware of what Robin actually did.
      onAutoApproved: (command) => console.log(mutedColor(`\n  $ ${command}`)),
      onFallback: ({ error, next }) => {
        console.log(
          mutedColor(`\n  ${error.message} — trying ${next.provider.name} · ${next.model}...`)
        );
        process.stdout.write(assistantColor('» '));
      },
    });

    if (result.ok) {
      process.stdout.write('\n');
      if (result.provider.id !== session.provider.id || result.model !== session.model) {
        session.provider = result.provider;
        session.model = result.model;
        printConnectionLine(session.provider.name, session.model);
      }
      await session.chatLog.write(session.provider.name, session.model, session.history);
      // Refresh in the background so the next divider has a fresh figure
      // without the user ever waiting on it. Failures are already swallowed
      // inside the cache; the catch is belt-and-braces against an unhandled
      // rejection taking down the process.
      void usageCache.get().catch(() => {});
    } else {
      console.log(errorColor(`\n✖ ${result.error?.message}`));
    }
  }
}
