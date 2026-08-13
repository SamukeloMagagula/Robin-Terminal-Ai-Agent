import type { Message } from '../providers/types.js';

/**
 * Characters per token. Four is the usual rule of thumb for English prose and
 * runs low for code and JSON, which is the right direction to be wrong in: an
 * underestimate here means a prompt that still fits.
 */
const CHARS_PER_TOKEN = 4;

/** Per-message overhead for role and framing, in tokens. */
const MESSAGE_OVERHEAD = 4;

/**
 * The share of the stated limit Robin will actually fill.
 *
 * The rest absorbs what this module cannot see: the tool schemas, which are
 * sent with every request and counted by the provider, and the error in the
 * estimate above. Trimming to exactly the limit would produce a prompt that is
 * rejected for being a few hundred tokens too long, which is the failure this
 * whole path exists to avoid.
 */
const BUDGET_SHARE = 0.8;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function messageTokens(message: Message): number {
  const toolCallText = (message.toolCalls ?? [])
    .map((call) => call.name + call.arguments)
    .join('');
  return estimateTokens(message.content + toolCallText) + MESSAGE_OVERHEAD;
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

export function budgetFor(limit: number): number {
  return Math.floor(limit * BUDGET_SHARE);
}

export interface TrimResult {
  messages: Message[];
  /** How many messages were dropped. Zero means the history was left alone. */
  dropped: number;
}

/**
 * An assistant message with tool calls, plus the tool results answering them.
 *
 * These have to travel together. Providers reject a tool result whose call is
 * missing, and an assistant message whose results were dropped leaves the model
 * asserting it ran something with no sign of what came back — so the unit of
 * dropping is the exchange, not the message.
 */
function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const message of messages) {
    const current = groups[groups.length - 1];
    if (message.role === 'tool' && current && current[0].toolCalls) {
      current.push(message);
    } else {
      groups.push([message]);
    }
  }
  return groups;
}

function truncateToTokens(text: string, tokens: number): string {
  const maxChars = Math.max(0, tokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  const marker = '\n...[trimmed to fit the context window]';
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

/**
 * Fits a conversation into a token budget by dropping the oldest exchanges.
 *
 * System messages are pinned: they carry the platform, the memory index and the
 * user's own instructions, and a conversation that has forgotten those is worse
 * than a short one. Everything else is kept newest-first, because the turn the
 * user is waiting on is the one that has to survive.
 *
 * The last group survives even when it does not fit, with its contents
 * truncated. Sending a mangled prompt beats refusing to send one: the
 * alternative is a turn that fails on a message the user just typed.
 */
export function trimHistory(messages: Message[], limit: number): TrimResult {
  const budget = budgetFor(limit);
  if (estimateMessagesTokens(messages) <= budget) return { messages, dropped: 0 };

  const pinned = messages.filter((message) => message.role === 'system');
  const groups = groupMessages(messages.filter((message) => message.role !== 'system'));

  let remaining = budget - estimateMessagesTokens(pinned);
  const kept: Message[][] = [];

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    const cost = estimateMessagesTokens(group);
    if (cost <= remaining) {
      remaining -= cost;
      kept.unshift(group);
      continue;
    }
    // The newest exchange gets truncated rather than dropped; anything older
    // that no longer fits is where the history stops.
    if (kept.length === 0) {
      kept.unshift(truncateGroup(group, Math.max(remaining, MESSAGE_OVERHEAD * group.length)));
    }
    break;
  }

  const keptMessages = kept.flat();
  return {
    messages: [...pinned, ...keptMessages],
    dropped: messages.length - pinned.length - keptMessages.length,
  };
}

function truncateGroup(group: Message[], tokens: number): Message[] {
  const perMessage = Math.max(1, Math.floor(tokens / group.length) - MESSAGE_OVERHEAD);
  return group.map((message) => ({
    ...message,
    content: truncateToTokens(message.content, perMessage),
  }));
}
