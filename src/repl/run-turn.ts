import type { Provider, Message } from '../providers/types.js';
import type { ConfirmFn } from '../tools/execute.js';
import type { Session } from './session.js';
import { buildSystemPrompt } from './session.js';
import { runAgentTurn } from '../agent-loop.js';
import { executeTool } from '../tools/execute.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { buildFallbackCandidates, type FallbackCandidate } from './fallback.js';
import { isModelUnsupported, isProviderQuotaExhausted } from '../providers/chat-error.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { listProviders } from '../providers/index.js';

export interface TurnOptions {
  onText: (text: string) => void;
  confirm: ConfirmFn;
  unsupportedStore: UnsupportedModelStore;
  /** Printed when a read-only command runs without asking. */
  onAutoApproved?: (command: string) => void;
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
}

export interface TurnResult {
  ok: boolean;
  /** May differ from the session's provider, when fallback rescued the turn. */
  provider: Provider;
  model: string;
  error?: Error;
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

  const useTools = options.tools ?? session.toolsEnabled;
  const allowFallback = options.fallback ?? true;
  const providers = options.providers ?? listProviders();

  let activeProvider = session.provider;
  let activeModel = session.model;
  let fallbackCandidates: FallbackCandidate[] | undefined;
  let fallbackIndex = 0;
  let lastError: Error | undefined;
  // Providers that refused this turn on quota. Reset per turn, because a
  // rate-limit window can reopen between messages.
  const quotaBlocked = new Set<string>();

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
        useTools ? TOOL_DEFINITIONS : [],
        {
          onText: options.onText,
          executeTool: (toolCall, confirm) =>
            executeTool(toolCall, confirm, { onAutoApproved: options.onAutoApproved }),
          confirm: options.confirm,
        }
      );
      session.history.push(...newMessages);
      return { ok: true, provider: activeProvider, model: activeModel };
    } catch (err) {
      lastError = err as Error;
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
  return { ok: false, provider: activeProvider, model: activeModel, error: lastError };
}
