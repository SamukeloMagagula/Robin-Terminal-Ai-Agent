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
import { SessionList } from './session-list.js';
import { runTurn } from './run-turn.js';
import { listenForInterrupt } from './interrupt.js';
import { readSlashAwareLine } from './slash-prompt.js';
import { addToInputHistory, InputHistoryStore } from './input-history.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { PersonalityTrustStore } from '../personality-trust.js';
import { TrustStore } from '../trust-store.js';
import { loadMcpConfig } from '../mcp/config.js';
import { McpRegistry } from '../mcp/registry.js';
import { filterTrustedServers } from '../mcp/trust.js';
import { MemoryStore } from '../memory/store.js';
import { WorkflowStore } from '../workflow/store.js';
import { RecallSearch } from '../recall/search.js';
import { UsageCache } from '../usage/openrouter-usage.js';
import { renderUsageLine } from '../usage/render-usage.js';
import { assistantColor, errorColor, mutedColor, divider, box } from '../ui/theme.js';
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

const APPROVAL_WORDING: Record<ConfirmRequest['kind'], { question: string; scope: string }> = {
  run_command: { question: 'Run it?', scope: 'commands' },
  write_file: { question: 'Write it?', scope: 'file writes' },
  read_file: { question: 'Read it?', scope: 'reads outside this directory' },
  mcp_tool: { question: 'Run it?', scope: 'MCP tools' },
};

/**
 * Loads mcp.json, asks about anything not already trusted, and connects what
 * survives. Returns an empty registry when there is nothing configured, so the
 * caller has one code path.
 *
 * An mcp.json entry says "run this command". Config files travel with
 * repositories and get pasted from the internet, so the user is shown the
 * exact command before anything is launched — the same gate PERSONALITY.md
 * gets, and the same two grants.
 */
async function startMcpServers(): Promise<McpRegistry> {
  const registry = new McpRegistry({
    onError: (server, message) =>
      console.log(mutedColor(`✖ MCP server "${server}" unavailable — ${message}`)),
  });

  const configured = await loadMcpConfig();
  if (configured.length === 0) return registry;

  const trusted = await filterTrustedServers(configured, new TrustStore(), async (config) => {
    const command = [config.command, ...(config.args ?? [])].join(' ');
    console.log(`\n${mutedColor(`MCP server "${config.name}" wants to run:`)}`);
    console.log(box([command]));
    console.log(
      mutedColor('Its tools become available to the model, each still asking before it runs.')
    );

    return expand<'yes' | 'no' | 'always'>({
      message: `Start "${config.name}"?`,
      default: 'n',
      choices: [
        { key: 'y', name: 'yes, this exact command', value: 'yes' },
        { key: 'n', name: 'no', value: 'no' },
        { key: 'a', name: 'yes, and trust this server even if its command changes', value: 'always' },
      ],
    });
  });

  await registry.load(trusted);
  const toolCount = registry.toolDefinitions().length;
  if (toolCount > 0) {
    console.log(mutedColor(`${toolCount} MCP tool(s) available from ${trusted.length} server(s).`));
  }
  return registry;
}

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
  // The active session is read through sessions.active rather than held in a
  // variable: /session switches which one that is, and a captured reference
  // would keep pointing at the conversation the user just left.
  const sessions = new SessionList(deps.provider, deps.model);
  // Prompt lines, for up/down recall. Persisted to ~/.robin/input-history —
  // the same private tree that already holds full transcripts, so this adds no
  // new class of exposure. ROBIN_NO_HISTORY_FILE=1 keeps it session-only.
  const inputHistoryStore = new InputHistoryStore();
  let inputHistory: string[] = await inputHistoryStore.load();
  const conversationStore = new ConversationStore();
  const skillStore = new SkillStore();
  const askForApproval = createApprovalGate();
  const usageCache = new UsageCache();
  const unsupportedStore = new UnsupportedModelStore();
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
  sessions.active.personality = personality;

  // Same reasoning, same placement: an mcp.json entry is a command Robin will
  // execute, so the user sees it before anything is launched.
  const mcpRegistry = await startMcpServers();

  // Built once. `session` is never reassigned — commands mutate its fields —
  // so this reference stays correct for the life of the loop.
  const ctx: ReplContext = {
    get session() {
      return sessions.active;
    },
    sessions,
    inputHistory,
    stores: {
      conversation: conversationStore,
      skill: skillStore,
      unsupported: unsupportedStore,
      usage: usageCache,
      inputHistory: inputHistoryStore,
      personalityTrust,
      memory: memoryStore,
      recall: recallSearch,
      workflow: workflowStore,
    },
    confirm: askForApproval,
    deps,
  };

  // Fetched before the banner so the figure is on screen from the first
  // frame; null (no key, no network) simply omits the line.
  const startupUsage = await usageCache.get();
  // Local reads only — gatherTelemetry never touches the network, so the
  // banner does not wait on a socket to draw.
  const hudStats = await gatherTelemetry({
    memory: memoryStore,
    skills: skillStore,
    // Counted from the same arrays runTurn assembles, so the meter cannot
    // drift from what the model is actually offered.
    toolCount:
      TOOL_DEFINITIONS.length +
      MEMORY_TOOL_DEFINITIONS.length +
      SKILL_TOOL_DEFINITIONS.length +
      mcpRegistry.toolDefinitions().length,
    mcpServerCount: mcpRegistry.serverCount(),
  });

  printBanner({
    stats: hudStats,
    providerName: sessions.active.provider.name,
    model: sessions.active.model,
    cwd: process.cwd(),
    sessionId: newSessionId(),
    toolsEnabled: sessions.active.toolsEnabled,
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
    const line = await readSlashAwareLine(
      inputHistory,
      sessions.list().length > 1 ? String(sessions.active.id) : undefined
    );
    inputHistory = addToInputHistory(inputHistory, line);
    // addToInputHistory returns a new array, so the context needs re-pointing
    // at it — /history reads and clears the live one.
    ctx.inputHistory = inputHistory;
    // Fire-and-forget: the store swallows its own errors, and the prompt must
    // never wait on a disk write.
    void inputHistoryStore.append(line);
    const cmd = parseCommand(line);

    if (cmd.type === 'exit') {
      // Each server is a child process Robin started; leaving them running
      // would outlive the session that spawned them.
      await mcpRegistry.closeAll();
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
    const result = await runTurn(sessions.active, cmd.arg, {
      signal: interrupt.signal,
      onText: (text) => process.stdout.write(text),
      confirm: askForApproval,
      unsupportedStore,
      // Read-only commands run unannounced otherwise; showing them keeps the
      // user aware of what Robin actually did.
      onAutoApproved: (command) => console.log(mutedColor(`\n  $ ${command}`)),
      onOutput: (chunk) => process.stdout.write(mutedColor(chunk)),
      onThinking: (text) => process.stdout.write(mutedColor(text)),
      mcp: mcpRegistry,
      memory: memoryStore,
      skills: skillStore,
      onFallback: ({ error, next }) => {
        console.log(
          mutedColor(`\n  ${error.message} — trying ${next.provider.name} · ${next.model}...`)
        );
        process.stdout.write(assistantColor('» '));
      },
    });

    // Must run whatever the outcome — leaving the terminal in raw mode would
    // make the next prompt unusable.
    interrupt.dispose();

    if (result.ok) {
      process.stdout.write('\n');
      if (result.aborted) {
        console.log(mutedColor('Interrupted. Your next message continues from here.'));
      }
      if (result.provider.id !== sessions.active.provider.id || result.model !== sessions.active.model) {
        sessions.active.provider = result.provider;
        sessions.active.model = result.model;
        printConnectionLine(sessions.active.provider.name, sessions.active.model);
      }
      await sessions.active.chatLog.write(sessions.active.provider.name, sessions.active.model, sessions.active.history);
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
