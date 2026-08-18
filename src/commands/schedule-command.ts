/**
 * `robin schedule` — jobs the gateway runs on a timer.
 *
 * Adding a job starts the gateway if it is not already running, because a job
 * that silently never fires is the worst outcome available here: nothing is
 * wrong, nothing is logged, and the report simply never arrives. The daemon it
 * starts is the same one `robin chat` and `robin serve` use.
 */

import chalk from 'chalk';
import { mutedColor } from '../ui/theme.js';
import { UserFacingError } from '../startup/bootstrap.js';
import { ScheduleStore, isValidJobName, type Job } from '../schedule/store.js';
import { describeCron, nextRun, parseCron } from '../schedule/cron.js';
import { AutonomyStore } from '../autonomy/grant-store.js';
import { CHANNELS } from '../channels/registry.js';

type Out = (line: string) => void;

export interface AddOptions {
  at: string;
  prompt: string;
  manifest?: string;
  deliver?: string;
  provider?: string;
  model?: string;
}

/** Reads `telegram:12345` — which chat a job's answer is sent to. */
export function parseDelivery(value: string): { channel: string; chatId: string } {
  const separator = value.indexOf(':');
  const channel = separator === -1 ? '' : value.slice(0, separator);
  const chatId = separator === -1 ? '' : value.slice(separator + 1);

  if (!channel || !chatId) {
    throw new UserFacingError(
      `Cannot read "${value}" as a destination. Use channel:chat-id, e.g. telegram:123456789.`
    );
  }
  const entry = CHANNELS[channel];
  if (!entry?.build) {
    throw new UserFacingError(
      entry
        ? `${channel} is not wired up yet, so nothing can be delivered there.`
        : `There is no channel called "${channel}". Available: ${Object.keys(CHANNELS).join(', ')}.`
    );
  }
  return { channel, chatId };
}

function describeNext(job: Job, now: Date): string {
  if (!job.enabled) return 'disabled';
  try {
    const next = nextRun(parseCron(job.cron), now);
    return next ? `next ${next.toLocaleString()}` : 'never — this schedule cannot happen';
  } catch {
    return 'unreadable schedule';
  }
}

function describeLast(job: Job): string {
  if (!job.lastRun) return 'never run';
  if (job.lastStatus === 'failed') return `last FAILED — ${job.lastError ?? 'no reason recorded'}`;
  return `last ran ${job.lastRun}`;
}

export interface AddDeps {
  store: ScheduleStore;
  autonomy: AutonomyStore;
  /** Brings the daemon up, since a job only fires while it is running. */
  ensure(): Promise<{ port: number }>;
  now: Date;
  out: Out;
}

export async function runScheduleAdd(
  name: string,
  options: AddOptions,
  deps: AddDeps
): Promise<void> {
  if (!isValidJobName(name)) {
    throw new UserFacingError(
      `"${name}" is not a usable job name. Use letters, numbers, dot, dash and underscore.`
    );
  }
  if (await deps.store.get(name)) {
    throw new UserFacingError(
      `A job called "${name}" already exists. Remove it first with \`robin schedule remove ${name}\`.`
    );
  }
  if (!options.prompt?.trim()) {
    throw new UserFacingError('A job needs a prompt — what should Robin be asked when it fires?');
  }

  // Parsed before anything is written, so a bad expression is an error now
  // rather than silence at 02:00.
  const schedule = parseCron(options.at);
  const deliver = options.deliver ? parseDelivery(options.deliver) : undefined;

  if (options.manifest && !(await deps.autonomy.get(options.manifest))) {
    throw new UserFacingError(
      `No manifest called "${options.manifest}". Run \`robin autonomy list\` to see what there is.`
    );
  }

  const job: Job = {
    name,
    cron: options.at,
    prompt: options.prompt.trim(),
    enabled: true,
    created: deps.now.toISOString(),
    manifestId: options.manifest,
    deliver,
    providerId: options.provider,
    model: options.model,
  };
  await deps.store.put(job);

  const next = nextRun(schedule, deps.now);
  deps.out(`${chalk.green('✓')} Job "${name}" saved — ${describeCron(schedule)}.`);
  if (next) deps.out(mutedColor(`  First run ${next.toLocaleString()}.`));

  if (!options.manifest) {
    deps.out(
      mutedColor(
        '  No manifest: tool calls will be refused, since nobody is at a terminal when it fires.'
      )
    );
  }

  const { port } = await deps.ensure();
  deps.out(mutedColor(`  The gateway is running on 127.0.0.1:${port} and will run it.`));
}

export async function runScheduleList(
  store: ScheduleStore,
  out: Out = console.log,
  now: Date = new Date()
): Promise<void> {
  const jobs = await store.list();
  if (jobs.length === 0) {
    out('No scheduled jobs.');
    out(mutedColor('Add one with `robin schedule add <name> --at "0 9 * * 1-5" --prompt "..."`.'));
    return;
  }

  out('Scheduled jobs:');
  for (const job of jobs) {
    const mark = job.enabled ? chalk.green('•') : mutedColor('◦');
    out(`  ${mark} ${chalk.cyan(job.name.padEnd(16))} ${job.cron.padEnd(16)} ${mutedColor(describeNext(job, now))}`);
    out(`    ${' '.repeat(16)} ${mutedColor(describeLast(job))}`);
  }
}

export async function runScheduleShow(
  store: ScheduleStore,
  name: string,
  out: Out = console.log,
  now: Date = new Date()
): Promise<void> {
  const job = await requireJob(store, name);
  out(`${chalk.cyan(job.name)} — ${job.cron} (${describeNext(job, now)})`);
  out('');
  out(`  prompt    ${job.prompt}`);
  out(`  manifest  ${job.manifestId ?? mutedColor('none — tool calls are refused')}`);
  out(`  deliver   ${job.deliver ? `${job.deliver.channel}:${job.deliver.chatId}` : mutedColor('nowhere — the answer is only recorded')}`);
  out(`  model     ${job.providerId ?? mutedColor('default')} · ${job.model ?? mutedColor('default')}`);
  out(`  ${describeLast(job)}`);
}

export async function runScheduleRemove(
  store: ScheduleStore,
  name: string,
  out: Out = console.log
): Promise<void> {
  await requireJob(store, name);
  await store.remove(name);
  out(`${chalk.green('✓')} Removed "${name}".`);
}

export async function runScheduleEnable(
  store: ScheduleStore,
  name: string,
  enabled: boolean,
  out: Out = console.log
): Promise<void> {
  const job = await requireJob(store, name);
  await store.put({ ...job, enabled });
  out(`${chalk.green('✓')} "${name}" ${enabled ? 'enabled' : 'disabled'}.`);
}

async function requireJob(store: ScheduleStore, name: string): Promise<Job> {
  const job = await store.get(name);
  if (!job) {
    throw new UserFacingError(
      `No job called "${name}". Run \`robin schedule list\` to see what there is.`
    );
  }
  return job;
}
