import type { Provider, Message } from '../providers/types.js';
import { ChatLog } from '../chat-log.js';
import { environmentPrompt } from '../environment-prompt.js';

/**
 * One conversation: who it talks to, what has been said, and how it behaves.
 *
 * These fields were local variables inside runRepl until sessions became
 * something there could be more than one of. Nothing here is new state — it is
 * the same state, given a name so it can be passed around.
 */
export interface Session {
  /** 1-based, and what the user types to switch to it. */
  id: number;
  /** Falls back to "provider · model" when unset. */
  label?: string;
  provider: Provider;
  model: string;
  history: Message[];
  /** Loaded from PERSONALITY.md. Standing behaviour, overridable by systemPrompt. */
  personality?: string;
  systemPrompt?: string;
  toolsEnabled: boolean;
  chatLog: ChatLog;
}

export function createSession(provider: Provider, model: string, id = 1): Session {
  return {
    id,
    provider,
    model,
    history: [],
    toolsEnabled: true,
    chatLog: new ChatLog(),
  };
}

/**
 * The system message sent with every turn.
 *
 * The environment preamble always comes first: /system controls the user's own
 * instructions, not what Robin knows about the machine it runs on. Personality
 * sits between the two — it is standing behaviour, and the task at hand should
 * be able to override the tone.
 */
export function buildSystemPrompt(session: Session): string {
  const parts = [environmentPrompt()];
  if (session.personality) parts.push(session.personality);
  if (session.systemPrompt) parts.push(session.systemPrompt);
  return parts.join('\n\n');
}
