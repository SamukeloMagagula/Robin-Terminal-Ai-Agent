/**
 * Who is allowed to drive Robin over a messaging channel.
 *
 * This is the whole security boundary for remote control, so it fails closed
 * at every step. A Telegram bot's username is public and anyone who finds it
 * can message it; on the other side of that conversation is a tool loop that
 * can read files and run commands on the operator's machine. An empty or
 * missing allowlist therefore means "nobody", never "everybody".
 */

export interface AccessDecision {
  allowed: boolean;
  /** Why it was refused — logged for the operator, never sent to the sender. */
  reason?: string;
}

/**
 * Ids are compared as trimmed strings. Telegram numeric ids, WhatsApp phone
 * numbers and Teams AAD object ids have nothing in common but being opaque
 * tokens, so no format is assumed or validated here.
 */
export function normalizeId(id: string): string {
  return id.trim();
}

export function parseAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number')
    .map((entry) => normalizeId(String(entry)))
    .filter((entry) => entry.length > 0);
}

/**
 * The check every inbound message passes through.
 *
 * A refused sender is told nothing — not "you are not on the allowlist", not
 * even an error. Silence is deliberate: any reply confirms a live Robin
 * instance behind this bot, which is exactly what someone probing it wants to
 * learn.
 */
export function checkAccess(senderId: string, allowlist: string[]): AccessDecision {
  if (allowlist.length === 0) {
    return { allowed: false, reason: 'allowlist is empty — no sender can be authorised' };
  }
  if (!allowlist.includes(normalizeId(senderId))) {
    return { allowed: false, reason: `sender ${senderId} is not on the allowlist` };
  }
  return { allowed: true };
}
