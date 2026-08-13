import { ChatRequestError } from './chat-error.js';

/**
 * Patterns that carry the model's context limit in the provider's own words.
 * Every one of these was seen in the wild; the capture group is always the
 * limit, never the prompt size, so a match can be trusted as a budget.
 *
 *   Copilot   prompt token count of 12660 exceeds the limit of 12288
 *   OpenAI    maximum context length is 8192 tokens. However, your messages...
 *   Anthropic prompt is too long: 250000 tokens > 200000 maximum
 *   Gemini    exceeds the maximum number of tokens allowed (1048576)
 */
const LIMIT_PATTERNS: RegExp[] = [
  /exceeds the limit of\s+(\d+)/i,
  /maximum context length is\s+(\d+)/i,
  />\s*(\d+)\s*maximum/i,
  /maximum number of tokens allowed\s*\(?(\d+)/i,
  /context (?:window|length) of\s+(\d+)/i,
];

const OVERFLOW_PHRASES: RegExp[] = [
  /\btoken count\b.{0,40}\bexceeds\b/i,
  /maximum context length/i,
  /prompt is too long/i,
  /\bcontext[_ -]?length[_ -]?exceeded\b/i,
  /\btoo many tokens\b/i,
  /input token count.{0,40}exceeds/i,
];

function messageOf(error: unknown): string | undefined {
  if (error instanceof ChatRequestError) return error.serverMessage ?? error.message;
  if (error instanceof Error) return error.message;
  return undefined;
}

/**
 * True when the request was refused for being too long.
 *
 * This is not a fact about the model being unavailable, and must not be treated
 * as one: the same model accepts the same prompt once it has been trimmed.
 * Falling through to another provider — which is all Robin used to do — spends
 * four requests discovering that the second model has a different limit.
 */
export function isContextOverflow(error: unknown): boolean {
  if (error instanceof ChatRequestError) {
    if (error.status === 429 || error.status >= 500) return false;
    if (error.code === 'context_length_exceeded') return true;
  }
  const message = messageOf(error);
  if (!message) return false;
  return OVERFLOW_PHRASES.some((phrase) => phrase.test(message));
}

/**
 * The model's context limit in tokens, when the provider stated it.
 *
 * Undefined is a normal outcome — some providers only say the prompt was too
 * long. The caller then falls back to estimating from what it just sent, which
 * is less precise but still bounded by something real.
 */
export function parseContextLimit(error: unknown): number | undefined {
  const message = messageOf(error);
  if (!message) return undefined;
  for (const pattern of LIMIT_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const limit = Number(match[1]);
    // A limit small enough to fit nothing is a misparse, not a budget.
    if (Number.isFinite(limit) && limit >= 512) return limit;
  }
  return undefined;
}
