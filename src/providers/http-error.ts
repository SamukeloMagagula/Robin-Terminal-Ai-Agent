/** A short, human-readable reason for a failed provider HTTP request, keyed off the status code. */
export function httpErrorDetail(status: number): string {
  if (status === 402) return 'insufficient credits/quota';
  if (status === 401 || status === 403) return 'authentication/authorization failed';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'server error';
  return 'request failed';
}

const MAX_SERVER_MESSAGE = 200;

/**
 * Pulls the provider's own explanation out of an error body.
 *
 * Providers say useful things here that a status code cannot — "The requested
 * model is not supported" is a very different problem from "rate limited", and
 * both arrive as a bare 400 or 429. Every OpenAI-compatible provider nests it
 * at `error.message`; some return a plain string.
 */
export function extractServerMessage(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const message =
      (parsed as { error?: { message?: unknown } })?.error?.message ??
      (parsed as { message?: unknown })?.message ??
      (typeof (parsed as { error?: unknown })?.error === 'string'
        ? (parsed as { error: string }).error
        : undefined);
    if (typeof message === 'string' && message.trim()) {
      return truncate(message.trim());
    }
    return undefined;
  } catch {
    // Not JSON — an HTML error page is noise, a short plain-text reason is not.
    if (trimmed.startsWith('<')) return undefined;
    return truncate(trimmed);
  }
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ');
  return single.length > MAX_SERVER_MESSAGE
    ? `${single.slice(0, MAX_SERVER_MESSAGE)}…`
    : single;
}

/** Machine-readable error code, where the provider supplies one (e.g. `model_not_supported`). */
export function extractErrorCode(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

export function describeChatError(providerLabel: string, status: number, body?: string): string {
  const base = `${providerLabel} chat request failed: ${status} (${httpErrorDetail(status)})`;
  const serverMessage = extractServerMessage(body);
  return serverMessage ? `${base} — ${serverMessage}` : base;
}
