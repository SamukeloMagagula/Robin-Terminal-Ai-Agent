import type { SessionSnapshot } from '../gateway/protocol.js';

/**
 * The conversation `robin chat` would pick up in this directory, if asked.
 *
 * Terminal sessions only. The Telegram bridge and the HTTP API create theirs
 * in the daemon's working directory, so matching on the directory alone once
 * meant a terminal opened there silently joined a chat's conversation.
 */
export function resumableSession(
  sessions: readonly SessionSnapshot[],
  cwd: string
): SessionSnapshot | undefined {
  return sessions.find((session) => session.cwd === cwd && session.origin === 'terminal');
}

/**
 * Which conversation to open: the existing one only when it was asked for.
 *
 * A daemon that outlives the terminal *can* hand back the conversation you
 * left, and at first it always did. But `robin chat` reads as "start a chat",
 * and resuming by default meant every new chat opened onto old subject matter,
 * with the model still answering in terms of it. Worse, the conversation in a
 * directory used daily never ended, so it grew until it hit the context limit.
 *
 * Resuming is still a keystroke away, and nothing is thrown away by starting
 * fresh — the old conversation stays until it is closed or ages out.
 */
export function sessionToOpen(
  sessions: readonly SessionSnapshot[],
  cwd: string,
  continueSession: boolean
): SessionSnapshot | undefined {
  return continueSession ? resumableSession(sessions, cwd) : undefined;
}
