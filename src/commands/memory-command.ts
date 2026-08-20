/**
 * `robin memory nudge` — a curated, scheduled memory-hygiene review.
 *
 * The scheduler already supports an arbitrary prompt on a cron, delivered
 * anywhere, and a scheduled session already has the memory tools
 * (remember/recall_memory) wired in exactly as an interactive one does — see
 * session-service.ts. Nothing new is needed to make Robin review its own
 * memory on a timer; what's missing is a curated prompt and a one-line way to
 * turn it on, rather than making every user hand-write the review prompt
 * themselves. This is a thin preset over `runScheduleAdd`, not a new
 * subsystem.
 */

import { runScheduleAdd, type AddDeps } from './schedule-command.js';
import { UserFacingError } from '../startup/bootstrap.js';

/** Weekly, Monday morning — frequent enough to matter, rare enough not to nag. */
export const DEFAULT_NUDGE_CRON = '0 9 * * 1';

/**
 * Fixed rather than user-named: this is one well-known job, not a general
 * facility for scheduling many memory reviews. Running the command twice
 * without removing the job first is refused by the same "already exists"
 * check `robin schedule add` gives any duplicate job name.
 */
export const NUDGE_JOB_NAME = 'memory-nudge';

const NUDGE_PROMPT =
  'Review your own memory (use recall_memory to read entries, and list what you ' +
  "have if you're unsure what exists). For each memory, judge whether it is: " +
  'stale (a fact that has likely changed since it was written), contradicted by ' +
  'another memory, or safe to forget (a scratch note that stopped being useful). ' +
  'Report what you found in a short list — do not silently forget or rewrite ' +
  'anything without saying so in the report. If nothing needs attention, say so ' +
  'briefly rather than padding the report.';

export interface NudgeOptions {
  /** Where the report is sent, e.g. "telegram:123456789". Required — a nudge with nowhere to go is not a nudge. */
  deliver: string;
  /** Cron expression. Defaults to weekly. */
  every?: string;
  /** The capability manifest the job may act under. Memory tools need no manifest; only relevant if you also want it to touch files or run commands. */
  manifest?: string;
}

export async function runMemoryNudge(options: NudgeOptions, deps: AddDeps): Promise<void> {
  if (!options.deliver?.trim()) {
    throw new UserFacingError(
      'A nudge needs somewhere to deliver its report. Pass --deliver, ' +
        'e.g. --deliver telegram:123456789.'
    );
  }

  await runScheduleAdd(
    NUDGE_JOB_NAME,
    {
      at: options.every ?? DEFAULT_NUDGE_CRON,
      prompt: NUDGE_PROMPT,
      manifest: options.manifest,
      deliver: options.deliver,
    },
    deps
  );
}
