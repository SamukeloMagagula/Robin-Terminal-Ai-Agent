/**
 * Process-level startup concerns: how Robin dies, and what it says on the way.
 *
 * The rule throughout is that a user should never see a raw stack trace for a
 * condition Robin can recognise. A stack trace is a bug report; anything the
 * user can act on deserves a sentence and a command instead.
 */

import { errorColor, mutedColor } from '../ui/theme.js';

/**
 * An error whose message already tells the user everything they need.
 *
 * Ordinary errors get a "run `robin doctor`" trailer, because an unrecognised
 * failure is exactly when that helps. Appending it to "Unknown channel
 * 'slack'" only adds noise to a message that is already complete, so these
 * are printed as-is.
 */
export class UserFacingError extends Error {
  readonly selfExplanatory = true;

  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function isUserFacing(err: unknown): err is UserFacingError {
  return Boolean(err && typeof err === 'object' && 'selfExplanatory' in err);
}

/**
 * Inquirer throws this when the user presses Ctrl+C at a prompt. It is a
 * normal way to leave, not an error, and printing "User force closed the
 * prompt with SIGINT" at someone who just pressed Ctrl+C tells them nothing.
 */
export function isPromptCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'ExitPromptError' || name === 'AbortPromptError') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /force closed the prompt/i.test(message);
}

/**
 * Turns the errors Robin can recognise into an explanation plus a remedy.
 * Anything unrecognised keeps its stack, because at that point the stack is
 * the most useful thing we have.
 */
export function describeStartupError(err: unknown): {
  message: string;
  remedy?: string;
  selfExplanatory?: boolean;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code;

  if (isUserFacing(err)) {
    return { message: raw, remedy: err.remedy, selfExplanatory: true };
  }

  if (/NODE_MODULE_VERSION|was compiled against a different/i.test(raw)) {
    return {
      message: 'A native module was built for a different version of Node.',
      remedy: 'Run `npm rebuild better-sqlite3` (or `npm ci`) and try again.',
    };
  }
  if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(raw)) {
    return {
      message: raw,
      remedy: 'Dependencies or the build output look incomplete — run `npm ci && npm run build`.',
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      message: raw,
      remedy: 'Permission denied — check the file’s permissions, or run `robin doctor`.',
    };
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return {
      message: raw,
      remedy: 'Network request failed — check your connection or proxy settings.',
    };
  }
  return { message: raw };
}

/** Prints a recognised error the way the user should see it, then sets the exit code. */
export function reportFatal(err: unknown): void {
  if (isPromptCancellation(err)) {
    console.log(mutedColor('\nCancelled.'));
    process.exitCode = 130; // Conventional exit code for SIGINT.
    return;
  }

  const { message, remedy, selfExplanatory } = describeStartupError(err);
  console.error(errorColor(`\n✖ ${message}`));
  if (remedy) console.error(mutedColor(`  ${remedy}`));

  if (!remedy && !selfExplanatory) {
    if (err instanceof Error && err.stack && process.env.ROBIN_DEBUG) {
      console.error(mutedColor(err.stack));
    } else {
      console.error(
        mutedColor('  Run `robin doctor` to check your installation, or set ROBIN_DEBUG=1 for the full stack.')
      );
    }
  }
  process.exitCode = 1;
}

/**
 * Last-resort handlers. Without these an unhandled rejection anywhere in the
 * async tree — a background usage refresh, a fire-and-forget disk write —
 * takes the process down mid-conversation with an unformatted dump, losing
 * whatever the user was in the middle of saying.
 */
export function installGlobalErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    reportFatal(reason);
  });
  process.on('uncaughtException', (err) => {
    reportFatal(err);
    // An uncaught exception leaves the process in an undefined state, so
    // unlike a rejection this genuinely cannot continue.
    process.exit(1);
  });
}

/**
 * Interactive commands need a real terminal for the provider and model
 * pickers. Detected up front so the failure is one clear sentence rather than
 * an inquirer stack trace from somewhere deep in the picker.
 */
export function requireInteractiveTerminal(
  isTty: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY)
): void {
  if (isTty) return;
  throw new Error(
    'Robin needs an interactive terminal for this command — its stdin is not a TTY. ' +
      'Run it directly in a terminal rather than through a pipe or redirect.'
  );
}
