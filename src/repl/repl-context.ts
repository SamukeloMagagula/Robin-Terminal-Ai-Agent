import type { Provider } from '../providers/types.js';
import type { GatewayClient } from '../gateway/client.js';
import type { SessionSnapshot } from '../gateway/protocol.js';
import type { ConversationStore } from '../conversation-store.js';
import type { SkillStore } from '../skills/store.js';
import type { UsageCache } from '../usage/openrouter-usage.js';
import type { InputHistoryStore } from './input-history.js';
import type { PersonalityTrustStore } from '../personality-trust.js';
import type { MemoryStore } from '../memory/store.js';
import type { RecallSearch } from '../recall/search.js';
import type { WorkflowStore } from '../workflow/store.js';

/**
 * The pickers, injected by the CLI so the REPL never imports inquirer's
 * provider/model menus directly.
 */
export interface ReplDeps {
  provider: Provider;
  model: string;
  pickModel: (provider: Provider) => Promise<string>;
  pickProviderAndModel: () => Promise<{ provider: Provider; model: string }>;
  /** Re-rolls a random provider/model pair, announcing what it landed on. */
  rollRandom: () => Promise<{ provider: Provider; model: string }>;
}

/**
 * Everything a command handler is allowed to touch.
 *
 * The conversation is no longer here. It lives in the gateway, and `client` is
 * how a handler asks about it or changes it — which is why handlers `await`
 * where they used to assign. `snapshot` is the last state the gateway reported
 * for the attached session: safe to read, never to write, and refreshed by
 * whatever RPC the handler just made.
 *
 * The stores that remain are the ones that were never part of a conversation:
 * the clipboard's input history, the spend figure, and the trust file.
 */
export interface ReplContext {
  client: GatewayClient;
  /** The session this terminal is attached to. */
  sessionId: number;
  /** Last known state of that session. Replaced, never mutated in place. */
  snapshot: SessionSnapshot;
  inputHistory: string[];
  stores: {
    conversation: ConversationStore;
    skill: SkillStore;
    usage: UsageCache;
    inputHistory: InputHistoryStore;
    personalityTrust: PersonalityTrustStore;
    memory: MemoryStore;
    recall: RecallSearch;
    workflow: WorkflowStore;
  };
  deps: ReplDeps;
}

export type CommandHandler = (ctx: ReplContext, arg?: string) => Promise<void>;
