import type { ChannelTransport } from './types.js';

/**
 * How often a streaming reply may be edited.
 *
 * Both platforms rate-limit edits per channel, and an edit per token would hit
 * that within a sentence — after which the *whole bridge* is throttled, not
 * just the streaming. Two seconds is frequent enough to read as live and slow
 * enough to never be the reason a reply is late.
 */
export const EDIT_INTERVAL_MS = 2000;

/** Shown while there is nothing to show, so the silence is explained. */
const PLACEHOLDER = '…';

export interface ReplyStream {
  /** Adds streamed text. Edits are throttled; nothing is sent per token. */
  push(text: string): Promise<void>;
  /** Writes the final text, whatever the throttle was doing. */
  finish(text: string): Promise<void>;
}

/**
 * A reply that appears immediately and fills in as it arrives.
 *
 * A chat client has no partial-message concept, so the alternative was a long
 * silence and then a wall of text — indistinguishable, while you wait, from
 * the bot having died. This posts once and edits.
 *
 * A transport that cannot edit gets the old behaviour: nothing until the end,
 * then the finished reply. That is a worse experience but never a broken one.
 */
export function createReplyStream(
  transport: ChannelTransport,
  chatId: string,
  now: () => number = Date.now
): ReplyStream {
  const canEdit = typeof transport.edit === 'function';
  let messageId: string | undefined;
  let posting: Promise<void> | undefined;
  let lastEditAt = 0;
  let pending = '';
  let sent = '';

  async function ensurePosted(): Promise<void> {
    if (messageId !== undefined || !canEdit) return;
    // One post, even if several chunks arrive while it is in flight.
    posting ??= (async () => {
      messageId = await transport.send(chatId, PLACEHOLDER);
      sent = PLACEHOLDER;
      lastEditAt = now();
    })();
    await posting;
  }

  return {
    async push(text: string): Promise<void> {
      if (!canEdit) return;
      pending = text;
      await ensurePosted();
      if (messageId === undefined) return;

      if (now() - lastEditAt < EDIT_INTERVAL_MS) return;
      const next = pending.trim();
      if (!next || next === sent) return;

      lastEditAt = now();
      sent = next;
      // A failed edit is not worth failing the turn over — the finished reply
      // is still sent, and that is the part that matters.
      await transport.edit?.(chatId, messageId, next).catch(() => {});
    },

    async finish(text: string): Promise<void> {
      const final = text.trim() || '(no reply)';

      if (canEdit && messageId !== undefined) {
        if (final !== sent) {
          await transport.edit?.(chatId, messageId, final).catch(async () => {
            // An edit can fail for reasons the send will not — too long for an
            // edit, or a message deleted underneath us. Falling back to a new
            // message means the answer still arrives.
            await transport.send(chatId, final);
          });
        }
        return;
      }
      await transport.send(chatId, final);
    },
  };
}
