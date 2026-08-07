/**
 * A failed chat request that carries the provider's machine-readable code
 * alongside the human message, so callers can act on specific failures
 * without string-matching the message.
 */
export class ChatRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, details: { status: number; code?: string }) {
    super(message);
    this.name = 'ChatRequestError';
    this.status = details.status;
    this.code = details.code;
  }
}

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
  if (error.code === 'model_not_supported') return true;
  if (error.code === 'model_not_found') return true;
  return false;
}
