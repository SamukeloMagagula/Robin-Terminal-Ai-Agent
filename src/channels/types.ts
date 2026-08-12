/**
 * Remote control channels — driving Robin from a messaging app.
 *
 * The transport interface is deliberately narrow: receive text, send text,
 * prove who you are. Everything above it (access control, session handling,
 * the agent turn itself) is transport-agnostic and lives in bridge.ts, so a
 * WhatsApp or Teams adapter is one file implementing three methods rather
 * than a second copy of the bridge.
 */

export interface IncomingMessage {
  /** Conversation identifier — one Robin session is kept per distinct chat. */
  chatId: string;
  /** Who sent it. Checked against the allowlist. */
  senderId: string;
  /** Display name, for logging. Never trusted for access decisions. */
  senderName?: string;
  text: string;
}

export interface ChannelTransport {
  /** Stable id, e.g. "telegram". Used in config and log lines. */
  readonly id: string;
  /** Human-readable name for messages to the operator. */
  readonly name: string;

  /**
   * Verifies credentials and returns the bot's own identity, so the operator
   * can confirm at startup which bot they just brought online. Throws when the
   * credentials are wrong — that must stop the process, not degrade it.
   */
  connect(): Promise<{ identity: string }>;

  /**
   * Delivers messages to `handler` until `signal` aborts.
   *
   * Implementations must swallow transient network errors and keep polling: a
   * bridge that exits on the first dropped connection is not something anyone
   * can leave running.
   */
  receive(
    handler: (message: IncomingMessage) => Promise<void>,
    signal: AbortSignal
  ): Promise<void>;

  send(chatId: string, text: string): Promise<void>;
}
