/**
 * A failed chat request that carries the provider's machine-readable code
 * alongside the human message, so callers can act on specific failures
 * without string-matching the message.
 */
export class ChatRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The provider's own explanation, without the status prefix. */
  readonly serverMessage: string | undefined;

  constructor(
    message: string,
    details: { status: number; code?: string; serverMessage?: string }
  ) {
    super(message);
    this.name = 'ChatRequestError';
    this.status = details.status;
    this.code = details.code;
    this.serverMessage = details.serverMessage;
  }
}

const UNSUPPORTED_CODES = new Set([
  'model_not_supported',
  'model_not_found',
  'NOT_FOUND', // Google
]);

/**
 * Phrases that describe a permanent property of the model rather than a
 * temporary condition. Message matching is a heuristic and deliberately narrow:
 * being wrong here costs one fallback option, never access, because the model
 * stays selectable by hand and `robin models forget` clears the record.
 */
const UNSUPPORTED_PHRASES = [
  /\bnot supported\b/i,
  /\bno longer available\b/i,
  /only supports .{0,40}\bAPI\b/i,
  /\bis not found\b|\bdoes not exist\b/i,
];

/**
 * True when the provider says this model does not exist or is not available to
 * this account — a permanent fact about the model, not a transient failure.
 *
 * GitHub Copilot's /models endpoint lists every model the service knows about,
 * not the subset a given plan may call: on one account 33 of the 49 chat
 * models it advertised answered with exactly this code. There is no field in
 * the catalogue that predicts it, so the only reliable source is having tried.
 */
export function isModelUnsupported(error: unknown): boolean {
  if (!(error instanceof ChatRequestError)) return false;

  // A rate limit or a server fault says nothing about the model. Recording
  // either would permanently hide a model that works fine tomorrow.
  if (error.status === 429 || error.status >= 500) return false;

  // The model is gone. Definitive, and provider-agnostic.
  if (error.status === 404) return true;

  if (error.code && UNSUPPORTED_CODES.has(error.code)) return true;

  // Google returns 400 INVALID_ARGUMENT for "This model only supports
  // Interactions API", which is permanent but carries no distinguishing code.
  if (error.status === 400 && error.serverMessage) {
    return UNSUPPORTED_PHRASES.some((phrase) => phrase.test(error.serverMessage as string));
  }
  return false;
}

/**
 * True when the provider is refusing on quota rather than on this particular
 * model. Quotas are per-account, so every sibling model will refuse too —
 * retrying them turns one failure into five identical ones.
 */
export function isProviderQuotaExhausted(error: unknown): boolean {
  if (!(error instanceof ChatRequestError)) return false;
  return error.status === 429 || error.status === 402;
}
