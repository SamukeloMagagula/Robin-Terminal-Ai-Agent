/**
 * Sending a finished job's answer to a chat.
 *
 * Only the send half of a transport is used — there is no poll loop, no
 * allowlist and no bridge, because nothing is being received. That asymmetry
 * is the point: delivery is Robin talking, not Robin listening, so none of the
 * access control that guards incoming messages applies or is needed.
 *
 * A transport is built per delivery rather than held open. A daily job would
 * otherwise keep a socket alive for twenty-four hours to use it for one
 * second, and a connection that has been idle that long is the one most likely
 * to have quietly died.
 */

import { loadChannelConfig } from '../channels/config.js';
import { CHANNELS } from '../channels/registry.js';
import { UserFacingError } from '../startup/bootstrap.js';
import type { Job } from './store.js';

export async function deliverToChannel(job: Job, text: string): Promise<void> {
  if (!job.deliver) return;
  const { channel, chatId } = job.deliver;

  const entry = CHANNELS[channel];
  if (!entry?.build) {
    throw new UserFacingError(
      `Cannot deliver "${job.name}" — ${entry ? `${channel} is not wired up yet` : `there is no channel called "${channel}"`}.`
    );
  }

  // The allowlist is not required: it governs who may drive Robin, and nobody
  // is driving it here.
  const config = await loadChannelConfig(channel, undefined, process.env, {
    requireAllowlist: false,
  });
  const transport = entry.build({ token: config.token, appToken: config.appToken });

  await transport.connect();
  await transport.send(chatId, `${job.name}\n\n${text}`);
}
