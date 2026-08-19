import type { Provider, Message, ToolDefinition, TokenUsage } from '../providers/types.js';
import type { ConfirmFn } from '../tools/execute.js';
import type { Session } from './session.js';
import { buildSystemPrompt } from './session.js';
import type { MemoryStore } from '../memory/store.js';
import type { SkillStore } from '../skills/store.js';
import { SKILL_TOOL_DEFINITIONS, composeSkillContext } from '../skills/tools.js';
import { MEDIA_TOOL_DEFINITIONS } from '../media/tools.js';
import type { MediaClient } from '../media/client.js';
import {
  MEMORY_TOOL_DEFINITIONS,
  NUDGE_EVERY,
  composeMemoryContext,
} from '../memory/tools.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { buildFallbackCandidates, type FallbackCandidate } from './fallback.js';
import { isModelUnsupported, isProviderQuotaExhausted } from '../providers/chat-error.js';
import { isContextOverflow, parseContextLimit } from '../providers/context-limit.js';
import { ContextLimitStore } from '../providers/context-limits.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { estimateMessagesTokens, trimHistory } from './trim-history.js';
import { listProviders } from '../providers/index.js';

export interface TurnOptions {
  onText: (text: string) => void;
  confirm: ConfirmFn;
  unsupportedStore: UnsupportedModelStore;
  /** Learned context windows. Defaults to the real store. */
  contextLimits?: ContextLimitStore;
  /** Called when history had to be dropped to fit the model's context window. */
  onTrim?: (info: { dropped: number; limit: number }) => void;
  /**
   * Where tools run for this turn. Defaults to the process's own directory.
   *
   * The gateway sets it per session: one daemon serves conversations started
   * in different repositories.
   */
  cwd?: string;
  /** Printed when a read-only command runs without asking. */
  onAutoApproved?: (command: string) => void;
  /** Live command output, for display only — the model still gets the whole result. */
  onOutput?: (chunk: string) => void;
  /** Reasoning summaries, where the provider streams them. Display only. */
  onThinking?: (text: string) => void;
  /** Enables the memory tools, the memory block, and the nudge. */
  memory?: MemoryStore;
  /** Enables the skill tools and the skills index. */
  skills?: SkillStore;
  /** Enables the media tools. Absent when Gemini is not logged in. */
  media?: MediaClient;
  /** MCP tools for this turn, offered to the model alongside the built-ins. */
  mcp?: {
    toolDefinitions(): ToolDefinition[];
    has(name: string): boolean;
    call(name: string, args: Record<string, unknown>): Promise<string>;
  };
  /** Called before each retry on a different model. */
  onFallback?: (info: { error: Error; next: FallbackCandidate }) => void;
  /**
   * Retry on other models when one fails. Default true.
   *
   * /compare turns this off: silently substituting a model in a comparison
   * answers a question the user did not ask.
   */
  fallback?: boolean;
  /** Defaults to the session's own toolsEnabled. */
  tools?: boolean;
  /** Injectable for tests; defaults to the real registry. */
  providers?: Provider[];
  /** Aborts the in-flight request. An abort is reported, never retried. */
  signal?: AbortSignal;
}

export interface TurnResult {
  ok: boolean;
  /**
   * What the whole turn cost, summed across rounds.
   *
   * Absent when no provider reported anything — not every model does, and a
   * missing count must never be shown as zero.
   */
  usage?: TokenUsage;
  /** May differ from the session's provider, when fallback rescued the turn. */
  provider: Provider;
  model: string;
  error?: Error;
  /** True when the user interrupted. The partial reply is kept in history. */
  aborted?: boolean;
}

/**
 * Runs one turn against `session`, mutating its history in place.
 *
 * On total failure the user message is rolled back out of the history, so a
 * failed turn does not leave two consecutive user messages for the next call.
 */
export async function runTurn(
  session: Session,
  userMessage: string,
  options: TurnOptions
): Promise<TurnResult> {
  const historyLengthBeforeTurn = session.history.length;
  session.history.push({ role: 'user', content: userMessage });

  // Refreshed per turn rather than at startup: the model may have written a
  // memory during this session, and a stale index would hide it from itself.
  if (options.memory) {
    session.memory = composeMemoryContext(
      await options.memory.profile(),
      await options.memory.index()
    );
  }
  if (options.skills) {
    session.skills = composeSkillContext(await options.skills.index());
  }
  session.turnCount += 1;
  const nudge = Boolean(options.memory) && session.turnCount % NUDGE_EVERY === 0;

  const useTools = options.tools ?? session.toolsEnabled;
  const allowFallback = options.fallback ?? true;
  const providers = options.providers ?? listProviders();
  const contextLimits = options.contextLimits ?? new ContextLimitStore();

  let activeProvider = session.provider;
  let activeModel = session.model;
  let fallbackCandidates: FallbackCandidate[] | undefined;
  let fallbackIndex = 0;
  let lastError: Error | undefined;
  // Providers that refused this turn on quota. Reset per turn, because a
  // rate-limit window can reopen between messages.
  const quotaBlocked = new Set<string>();

  // Summed across rounds: a turn with three tool calls made four requests, and
  // each was billed. Reset per attempt, because a turn that fell back to
  // another model should not report the failed attempt's tokens as well.
  let usage: TokenUsage | undefined;
  const addUsage = (round: TokenUsage): void => {
    usage = {
      inputTokens: (usage?.inputTokens ?? 0) + round.inputTokens,
      outputTokens: (usage?.outputTokens ?? 0) + round.outputTokens,
    };
  };

  // Models whose context window has already been re-measured this turn. One
  // correction is a fix; a second would mean the trim did not work, and looping
  // on it would re-send the same oversized prompt forever.
  const remeasured = new Set<string>();

  while (true) {
    try {
      const messagesForTurn: Message[] = [
        { role: 'system', content: buildSystemPrompt(session, { nudge }) },
        ...session.history,
      ];
      // A limit is only known once this model has refused something for being
      // too long. Until then the history goes out whole, as it always did.
      const limit = await contextLimits.get(activeProvider.id, activeModel);
      const trimmed = limit ? trimHistory(messagesForTurn, limit) : undefined;
      if (limit && trimmed && trimmed.dropped > 0) {
        options.onTrim?.({ dropped: trimmed.dropped, limit });
      }
      const newMessages = await runAgentTurn(
        activeProvider,
        activeModel,
        trimmed?.messages ?? messagesForTurn,
        useTools
          ? [
              ...TOOL_DEFINITIONS,
              ...(options.memory ? MEMORY_TOOL_DEFINITIONS : []),
              ...(options.skills ? SKILL_TOOL_DEFINITIONS : []),
              ...(options.media ? MEDIA_TOOL_DEFINITIONS : []),
              ...(options.mcp?.toolDefinitions() ?? []),
            ]
          : [],
        {
          onText: options.onText,
          onThinking: options.onThinking,
          onUsage: addUsage,
          executeTool: (toolCall, confirm) =>
            executeTool(toolCall, confirm, {
              onAutoApproved: options.onAutoApproved,
              onOutput: options.onOutput,
              cwd: options.cwd,
              mcp: options.mcp,
              memory: options.memory,
              skills: options.skills,
              media: options.media,
            }),
          confirm: options.confirm,
          signal: options.signal,
        }
      );
      session.history.push(...newMessages);
      // An abort returns normally from runAgentTurn, so the catch below — and
      // with it the fallback chain — is unreachable for it by construction.
      return {
        ok: true,
        provider: activeProvider,
        model: activeModel,
        usage,
        aborted: options.signal?.aborted ?? false,
      };
    } catch (err) {
      lastError = err as Error;
      // A failed attempt's tokens belong to the attempt, not to whatever
      // eventually answers.
      usage = undefined;
      // Too long is not the same as unavailable: this model will take this
      // conversation once it is shorter. Learn the window, then retry the same
      // model with the history trimmed — walking down the fallback chain would
      // just discover that the next model has a different window.
      if (isContextOverflow(err)) {
        const key = `${activeProvider.id}:${activeModel}`;
        const stated = parseContextLimit(err);
        if (stated || !remeasured.has(key)) {
          // When the provider did not say what the limit was, infer one from
          // the prompt that was just rejected: it is known not to fit, so
          // anything below it is a strictly better guess than the unknown.
          const estimated = Math.floor(
            estimateMessagesTokens([
              { role: 'system', content: buildSystemPrompt(session, { nudge }) },
              ...session.history,
            ]) * 0.75
          );
          await contextLimits.record(activeProvider.id, activeModel, stated ?? estimated);
        }
        if (!remeasured.has(key)) {
          remeasured.add(key);
          continue;
        }
      }
      // A model the provider says it does not support will never work, so
      // remember it rather than retrying into the same wall.
      if (isModelUnsupported(err)) {
        await options.unsupportedStore.record(activeProvider.id, activeModel);
      }
      // A quota refusal is about the account, not the model, so every sibling
      // model on that provider will refuse identically.
      if (isProviderQuotaExhausted(err)) {
        quotaBlocked.add(activeProvider.id);
      }
      if (!allowFallback) break;

      if (!fallbackCandidates) {
        fallbackCandidates = await buildFallbackCandidates(
          activeProvider,
          activeModel,
          providers,
          options.unsupportedStore
        );
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
      options.onFallback?.({ error: lastError, next });
      activeProvider = next.provider;
      activeModel = next.model;
    }
  }

  session.history.length = historyLengthBeforeTurn;
  return { ok: false, provider: activeProvider, model: activeModel, usage, error: lastError };
}
