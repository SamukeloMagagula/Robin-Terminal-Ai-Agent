/**
 * Running one scheduled job as a conversation the gateway has with itself.
 *
 * A job is a prompt, so the machinery is the machinery that already exists:
 * create a session, send the prompt, wait, take the answer. What it adds is
 * the parts a scheduled run needs and an interactive one does not — a manifest
 * to act under, no human to fall back on, and no session left behind
 * afterwards, since a job firing daily would otherwise accumulate one
 * conversation per day forever.
 */

import { UserFacingError } from '../startup/bootstrap.js';
import { isEmptyReplyNote } from '../agent-loop.js';
import type { SessionService } from '../gateway/session-service.js';
import type { Job } from './store.js';

export interface JobRunnerDeps {
  sessions: SessionService;
  /** The provider and model to use when a job names none. */
  defaults(): Promise<{ providerId: string; model: string }>;
  /** Where a job's tools run. The gateway's own directory. */
  cwd: string;
}

export function createJobRunner(deps: JobRunnerDeps): (job: Job) => Promise<string> {
  return async (job: Job): Promise<string> => {
    const fallback = await deps.defaults();
    const providerId = job.providerId ?? fallback.providerId;
    const model = job.model ?? fallback.model;

    // A job added before `robin setup` has nothing to fall back on. Saying so
    // is worth a line, because the alternative — 'Unknown provider ""' at
    // 02:00 in a log nobody is reading — explains nothing.
    if (!providerId || !model) {
      throw new UserFacingError(
        `"${job.name}" has no provider or model to run with. Run \`robin setup\` to set a default, ` +
          `or give the job its own with \`--provider\` and \`--model\`.`
      );
    }

    const { id } = deps.sessions.create({
      providerId,
      model,
      cwd: deps.cwd,
      label: `schedule ${job.name}`,
      origin: 'schedule',
      // Never. A scheduled run is exactly the case where "approve everything"
      // would be indistinguishable from having no approval gate at all; the
      // manifest is how a job is granted anything.
      autoApprove: false,
      manifestId: job.manifestId,
    });

    try {
      deps.sessions.sendPrompt(id, job.prompt, { surface: 'schedule', who: job.name });
      await deps.sessions.idle();

      const history = deps.sessions.history(id);
      const answer = [...history].reverse().find((message) => message.role === 'assistant');
      const text = typeof answer?.content === 'string' ? answer.content.trim() : '';
      // An empty answer reaches here as a note telling an interactive user to
      // ask again. Delivering that to a chat as though it were the report is
      // worse than reporting the run as failed, which is what it was.
      if (!text || isEmptyReplyNote(text)) {
        throw new UserFacingError(
          `"${job.name}" produced no answer. Check the provider and the prompt.`
        );
      }
      return text;
    } finally {
      // Even when the run threw: the conversation is over either way, and a
      // failed job that leaves a session behind fails a little more every day.
      deps.sessions.close(id);
    }
  };
}
