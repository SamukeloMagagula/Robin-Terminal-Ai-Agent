import chalk from 'chalk';
import { expand } from '@inquirer/prompts';
import { parseCommand, type ParsedCommand } from './parse-command.js';
import { type ConfirmRequest } from '../tools/execute.js';
import { printBanner, printConnectionLine } from '../ui/banner.js';
import { gatherTelemetry } from '../ui/hud/telemetry.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { MEMORY_TOOL_DEFINITIONS } from '../memory/tools.js';
import { SKILL_TOOL_DEFINITIONS } from '../skills/tools.js';
import { newSessionId } from '../session-id.js';
import { ConversationStore } from '../conversation-store.js';
import { SkillStore } from '../skills/store.js';
import { listenForInterrupt } from './interrupt.js';
import { readSlashAwareLine } from './slash-prompt.js';
import { addToInputHistory, InputHistoryStore } from './input-history.js';
import { PersonalityTrustStore } from '../personality-trust.js';
import { MemoryStore } from '../memory/store.js';
import { WorkflowStore } from '../workflow/store.js';
import { RecallSearch } from '../recall/search.js';
import { UsageCache } from '../usage/openrouter-usage.js';
import { renderUsageLine } from '../usage/render-usage.js';
import { assistantColor, errorColor, mutedColor, divider, box } from '../ui/theme.js';
import { ensureGateway } from '../gateway/ensure.js';
import { GatewayClient } from '../gateway/client.js';
import type {
  AttachResult,
  GatewayEvent,
  PromptAccepted,
  SessionSnapshot,
} from '../gateway/protocol.js';
import { renderEvent, type EventOutput } from './render-events.js';
import {
  type ReplContext,
  type CommandHandler,
  type ReplDeps,
  handleHelp,
  handleUsage,
  handleRecall,
  handleClear,
  handleCopy,
  handleSkill,
  handleSave,
  handleLoad,
  handleModel,
  handleProvider,
  handleRandom,
  handleSystem,
  handleTools,
  handleHistory,
  handlePersonality,
  handleMemory,
  handleSession,
  handleWorkflow,
  loadPersonality,
} from './commands/index.js';

// Re-exported so src/cli.ts keeps importing ReplDeps from here unchanged.
export type { ReplDeps } from './repl-context.js';

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
  model: handleModel,
  provider: handleProvider,
  random: handleRandom,
  system: handleSystem,
  tools: handleTools,
  history: handleHistory,
  personality: handlePersonality,
  memory: handleMemory,
  session: handleSession,
  workflow: handleWorkflow,
};

const APPROVAL_WORDING: Record<ConfirmRequest['kind'], string> = {
  run_command: 'Run it?',
  write_file: 'Write it?',
  read_file: 'Read it?',
  mcp_tool: 'Run it?',
};

/**
 * Puts one approval in front of the user.
 *
 * The choices are yes and no. "Stop asking this session" is the gateway's
 * memory now, not the REPL's — it already refuses an identical repeat without
 * asking, and offering choices here that the protocol cannot yet carry would
 * be two buttons that quietly do nothing.
 */
function askApproval(
  event: Extract<GatewayEvent, { kind: 'approval.request' }>
): { answer: Promise<boolean>; cancel: () => void } {
  const origin =
    event.origin.surface === 'terminal'
      ? []
      : [
          // Without this you cannot tell a command you asked for from one a
          // remote message asked for, and the gate stops meaning anything.
          `Requested from ${event.origin.surface}${event.origin.who ? ` by ${event.origin.who}` : ''}`,
          '',
        ];
  console.log(`\n${box([...origin, ...event.request.message.split('\n')])}`);

  const prompt = expand<'yes' | 'no'>({
    message: APPROVAL_WORDING[event.request.kind],
    default: 'n',
    choices: [
      { key: 'y', name: 'yes, this once', value: 'yes' },
      { key: 'n', name: 'no', value: 'no' },
    ],
  });

  return {
    // A cancelled prompt rejects; another client answering first is not an
    // error, so it settles as a plain "no" that is never sent.
    answer: prompt.then((answer) => answer === 'yes').catch(() => false),
    cancel: () => prompt.cancel(),
  };
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  // Prompt lines, for up/down recall. Persisted to ~/.robin/input-history —
  // the same private tree that already holds full transcripts, so this adds no
  // new class of exposure. ROBIN_NO_HISTORY_FILE=1 keeps it session-only.
  const inputHistoryStore = new InputHistoryStore();
  let inputHistory: string[] = await inputHistoryStore.load();
  const conversationStore = new ConversationStore();
  const skillStore = new SkillStore();
  const usageCache = new UsageCache();
  const personalityTrust = new PersonalityTrustStore();
  const memoryStore = new MemoryStore();
  const workflowStore = new WorkflowStore();
  const recallSearch = new RecallSearch(undefined, (count) =>
    console.log(mutedColor(`Indexing ${count} transcript(s) for search...`))
  );

  // Before the banner, deliberately: the trust prompt asks the user to approve
  // text that becomes the system prompt, and burying it under the banner is
  // how people learn to approve without reading.
  const { text: personality } = await loadPersonality(personalityTrust);

  const info = await ensureGateway();
  const client = await GatewayClient.connect({
    port: info.port,
    token: info.token,
    kind: 'terminal',
    canApprove: true,
    cwd: process.cwd(),
  });

  // A session this directory already owns is the one to continue. Picking it up
  // rather than starting another is the whole point of a daemon that outlives
  // the terminal: closing the window is no longer the end of a conversation.
  const here = client.sessions.find((session) => session.cwd === process.cwd());
  let snapshot =
    here ??
    (await client.request<SessionSnapshot>('session.create', {
      providerId: deps.provider.id,
      model: deps.model,
      cwd: process.cwd(),
    }));
  if (personality) {
    snapshot = await client.request<SessionSnapshot>('session.update', {
      id: snapshot.id,
      patch: { personality },
    });
  }
  const attached = await client.request<AttachResult>('session.attach', { id: snapshot.id });

  const ctx: ReplContext = {
    client,
    sessionId: snapshot.id,
    snapshot,
    inputHistory,
    stores: {
      conversation: conversationStore,
      skill: skillStore,
      usage: usageCache,
      inputHistory: inputHistoryStore,
      personalityTrust,
      memory: memoryStore,
      recall: recallSearch,
      workflow: workflowStore,
    },
    deps,
  };

  const output: EventOutput = {
    text: (chunk) => process.stdout.write(chunk),
    muted: (line) => process.stdout.write(mutedColor(line)),
    error: (line) => console.log(errorColor(line)),
    connectionChanged: (providerName, model) => printConnectionLine(providerName, model),
  };

  // Approvals in flight, so a box can be withdrawn when another client answers
  // first rather than left on screen as a question nobody is waiting on.
  const openApprovals = new Map<string, () => void>();

  client.on((sessionId, event) => {
    if (sessionId !== undefined && sessionId !== ctx.sessionId) return;

    if (event.kind === 'approval.request') {
      const { answer, cancel } = askApproval(event);
      openApprovals.set(event.approvalId, cancel);
      void answer.then(async (approved) => {
        if (!openApprovals.delete(event.approvalId)) return;
        await client
          .request('approval.answer', { approvalId: event.approvalId, approved })
          .catch(() => {});
      });
      return;
    }
    if (event.kind === 'approval.resolved') {
      const cancel = openApprovals.get(event.approvalId);
      if (cancel) {
        openApprovals.delete(event.approvalId);
        cancel();
        console.log(mutedColor(`Answered elsewhere (${event.approved ? 'yes' : 'no'}).`));
      }
      return;
    }
    if (event.kind === 'session.changed') {
      ctx.snapshot = event.snapshot;
    }
    renderEvent(event, output);
  });

  client.onClose(() => {
    console.log(
      errorColor('\n✖ The gateway went away. Start it again with `robin chat`.')
    );
    process.exit(1);
  });

  // Fetched before the banner so the figure is on screen from the first
  // frame; null (no key, no network) simply omits the line.
  const startupUsage = await usageCache.get();
  // Local reads only — gatherTelemetry never touches the network, so the
  // banner does not wait on a socket to draw.
  const hudStats = await gatherTelemetry({
    memory: memoryStore,
    skills: skillStore,
    toolCount:
      TOOL_DEFINITIONS.length + MEMORY_TOOL_DEFINITIONS.length + SKILL_TOOL_DEFINITIONS.length,
    mcpServerCount: 0,
  });

  printBanner({
    stats: hudStats,
    providerName: snapshot.providerName,
    model: snapshot.model,
    cwd: process.cwd(),
    sessionId: newSessionId(),
    toolsEnabled: snapshot.toolsEnabled,
    usageLine: startupUsage ? renderUsageLine(startupUsage) : undefined,
  });

  if (attached.history.length > 0) {
    // Rejoining, not starting. Say so rather than presenting a conversation
    // with history as a blank slate.
    console.log(
      mutedColor(
        `Continuing the conversation in this directory — ${attached.history.length} message(s) so far. /clear starts over.`
      )
    );
  }
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

    // `inputHistory` is what the user typed at the prompt; the conversation
    // itself lives in the gateway. Distinct names on purpose.
    const line = await readSlashAwareLine(inputHistory, undefined);
    inputHistory = addToInputHistory(inputHistory, line);
    ctx.inputHistory = inputHistory;
    // Fire-and-forget: the store swallows its own errors, and the prompt must
    // never wait on a disk write.
    void inputHistoryStore.append(line);
    const cmd = parseCommand(line);

    if (cmd.type === 'exit') {
      // The gateway keeps running on purpose: a Telegram conversation must not
      // end because a terminal was closed. `robin gateway stop` ends it.
      await client.close();
      await recallSearch.close();
      break;
    }

    if (cmd.type === 'unknown') {
      console.log(errorColor(`✖ Unknown command: ${cmd.arg}. Type /help for commands.`));
      continue;
    }

    const handler = HANDLERS[cmd.type];
    if (handler) {
      await handler(ctx, cmd.arg);
      continue;
    }

    if (!cmd.arg) continue;

    process.stdout.write(assistantColor('» '));
    const interrupt = listenForInterrupt();
    let accepted: PromptAccepted | undefined;
    try {
      accepted = await client.request<PromptAccepted>('prompt.send', {
        id: ctx.sessionId,
        text: cmd.arg,
      });
      if (accepted.queuePosition > 0) {
        console.log(mutedColor(`\n  Queued behind ${accepted.queuePosition} turn(s).`));
      }
      // The gateway owns the turn; this waits for it to say the turn is over.
      await new Promise<void>((resolve) => {
        const stop = client.on((sessionId, event) => {
          if (sessionId !== ctx.sessionId) return;
          if (event.kind !== 'turn.finished' || event.turnId !== accepted?.turnId) return;
          stop();
          resolve();
        });
        interrupt.signal.addEventListener('abort', () => {
          void client.request('turn.interrupt', { turnId: accepted?.turnId }).catch(() => {});
        });
      });
      process.stdout.write('\n');
    } catch (err) {
      console.log(errorColor(`\n✖ ${(err as Error).message}`));
    } finally {
      // Must run whatever the outcome — leaving the terminal in raw mode would
      // make the next prompt unusable.
      interrupt.dispose();
    }

    // Refresh in the background so the next divider has a fresh figure without
    // the user ever waiting on it.
    void usageCache.get().catch(() => {});
  }
}
