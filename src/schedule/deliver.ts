/**
 * Sending a finished job's answer where the job said to send it.
 *
 * Two destinations, and they are not the same kind of thing. A chat channel is
 * a transport Robin can also be driven from; email is somewhere Robin can only
 * send. Routing between them is kept here, as one decision, so the scheduler
 * stays a timer and knows nothing about either.
 *
 * Only the send half of a transport is used — no poll loop, no allowlist, no
 * bridge, because nothing is being received. Delivery is Robin talking, not
 * Robin listening, so none of the access control that guards incoming messages
 * applies or is needed.
 */

import { loadChannelConfig } from '../channels/config.js';
import { CHANNELS } from '../channels/registry.js';
import { EMAIL_TARGET, createSender, loadEmailConfig, sendEmail } from '../channels/email.js';
import { UserFacingError } from '../startup/bootstrap.js';
import type { Job } from './store.js';

export interface DeliveryDeps {
  toChannel(channel: string, chatId: string, text: string): Promise<void>;
  toEmail(to: string, subject: string, body: string): Promise<void>;
}

export async function deliverJob(job: Job, text: string, deps: DeliveryDeps): Promise<void> {
  if (!job.deliver) return;
  const { channel, chatId } = job.deliver;

  if (channel === EMAIL_TARGET) {
    // The job's name is the subject, so repeating it in the body would just be
    // saying the same thing twice.
    await deps.toEmail(chatId, job.name, text);
    return;
  }

  // A chat message has no subject line, so the name has to be in the text or
  // an answer arrives with no clue which job produced it.
  await deps.toChannel(channel, chatId, `${job.name}\n\n${text}`);
}

/**
 * A transport is built per delivery rather than held open. A daily job would
 * otherwise keep a socket alive for twenty-four hours to use it for one
 * second, and a connection idle that long is the one most likely to have
 * quietly died.
 */
async function sendToChannel(channel: string, chatId: string, text: string): Promise<void> {
  const entry = CHANNELS[channel];
  if (!entry?.build) {
    throw new UserFacingError(
      entry
        ? `${channel} is not wired up yet, so nothing can be delivered there.`
        : `There is nowhere called "${channel}".`
    );
  }

  // The allowlist governs who may drive Robin, and nobody is driving it here.
  const config = await loadChannelConfig(channel, undefined, process.env, {
    requireAllowlist: false,
  });
  const transport = entry.build({ token: config.token, appToken: config.appToken });

  await transport.connect();
  await transport.send(chatId, text);
}

async function sendToEmail(to: string, subject: string, body: string): Promise<void> {
  const config = await loadEmailConfig();
  await sendEmail(config, to, subject, body, await createSender(config));
}

/** What the gateway hands the scheduler. */
export function deliverJobAnswer(job: Job, text: string): Promise<void> {
  return deliverJob(job, text, { toChannel: sendToChannel, toEmail: sendToEmail });
}
