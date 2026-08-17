import type { SessionSnapshot } from '../gateway/protocol.js';

/**
 * The conversation `robin chat` would pick up in this directory, if asked.
 *
 * The most recently touched one, not simply the first found. A directory used
 * to hold a single long-lived session, so any match was the match; now that
 * every `robin chat` opens a new one they accumulate, and picking the first
 * meant `--continue` reliably resumed the *oldest* conversation in the
 * directory — the one least likely to be wanted.
 *
 * Conversations nobody has said anything in are skipped for the same reason:
 * an empty session left behind by a `robin chat` that was closed immediately
 * is not what "continue" means.
 *
 * Terminal sessions only. The Telegram bridge and the HTTP API create theirs
 * in the daemon's working directory, so matching on the directory alone once
 * meant a terminal opened there silently joined a chat's conversation.
 */
export function resumableSession(
  sessions: readonly SessionSnapshot[],
  cwd: string
): SessionSnapshot | undefined {
  const here = sessions.filter(
    (session) => session.cwd === cwd && session.origin === 'terminal' && session.messageCount > 0
  );
  if (here.length === 0) return undefined;

  return here.reduce((newest, session) =>
    session.updatedAt > newest.updatedAt ? session : newest
  );
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
