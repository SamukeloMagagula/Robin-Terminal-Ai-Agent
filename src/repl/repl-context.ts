import type { Session } from './session.js';
import type { Provider } from '../providers/types.js';
import type { ConversationStore } from '../conversation-store.js';
import type { SkillStore } from '../skill-store.js';
import type { UnsupportedModelStore } from '../providers/unsupported-models.js';
import type { UsageCache } from '../usage/openrouter-usage.js';
import type { InputHistoryStore } from './input-history.js';
import type { PersonalityTrustStore } from '../personality-trust.js';
import type { ConfirmFn } from '../tools/execute.js';

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
 * `session` is the active conversation. Everything else is app-level and
 * deliberately shared: the approval gate's "stop asking this session" promise
 * means this process, and the stores are one-per-machine.
 */
export interface ReplContext {
  session: Session;
  inputHistory: string[];
  stores: {
    conversation: ConversationStore;
    skill: SkillStore;
    unsupported: UnsupportedModelStore;
    usage: UsageCache;
    inputHistory: InputHistoryStore;
    personalityTrust: PersonalityTrustStore;
  };
  confirm: ConfirmFn;
  deps: ReplDeps;
}

export type CommandHandler = (ctx: ReplContext, arg?: string) => Promise<void>;
