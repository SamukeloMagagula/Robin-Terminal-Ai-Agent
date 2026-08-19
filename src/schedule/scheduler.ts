/**
 * The timer that fires scheduled jobs, living inside the gateway.
 *
 * The gateway is already the long-lived process that owns sessions, approvals
 * and manifests, so a job is a prompt it sends itself. Nothing here knows how
 * to run a turn or how to reach Telegram — both arrive as functions, which is
 * what keeps the firing rules testable without a daemon or a network.
 *
 * Missed runs are not made up. A laptop asleep at 02:00 should not fire the
 * backup report at 09:14 when it wakes: the run's value was in its timing, and
 * a late one is at best noise and at worst wrong. `schedule list` shows when a
 * job last ran, which is where a missed run becomes visible.
 */

import { matchesCron, parseCron } from './cron.js';
import type { Job, ScheduleStore } from './store.js';

export interface SchedulerDeps {
  store: ScheduleStore;
  /** Runs the job's prompt and returns the answer. */
  runJob(job: Job): Promise<string>;
  /** Sends an answer where the job asked for it. Only called when it says. */
  deliver(job: Job, text: string): Promise<void>;
  log?(line: string): void;
}

/** Ticks a little faster than a minute so a minute is never stepped over. */
const TICK_MS = 30_000;

export class Scheduler {
  /**
   * The minute each job was last fired in, as `name` → `YYYY-MM-DDTHH:mm`.
   *
   * Kept in memory rather than read from lastRun because lastRun is written
   * after the run finishes, and a job taking longer than a tick would
   * otherwise be started again while still going.
   */
  private readonly firedAt = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(new Date());
    }, TICK_MS);
    // A pending timer must not be the reason the daemon cannot be shut down.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The minute `date` falls in, which is the unit a cron schedule names. */
  private static minuteKey(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  /**
   * Runs everything due at `now`.
   *
   * Never throws. One job with a broken schedule, an unreachable provider or a
   * channel that refuses the message must not stop the others or kill the
   * timer that would have run them tomorrow.
   */
  async tick(now: Date): Promise<void> {
    const minute = Scheduler.minuteKey(now);
    let jobs: Job[];
    try {
      jobs = await this.deps.store.list();
    } catch {
      return;
    }

    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.firedAt.get(job.name) === minute) continue;

      let due: boolean;
      try {
        due = matchesCron(parseCron(job.cron), now);
      } catch {
        // Only reachable if the file was hand-edited: put() parses on the way
        // in. Skipping is the safe reading — a schedule nobody can read is not
        // an instruction to run something.
        this.log(`schedule: ignoring "${job.name}" — its schedule cannot be read`);
        continue;
      }
      if (!due) continue;

      this.firedAt.set(job.name, minute);
      await this.run(job, now);
    }
  }

  private async run(job: Job, now: Date): Promise<void> {
    this.log(`schedule: running "${job.name}"`);
    const at = now.toISOString();

    try {
      const answer = await this.deps.runJob(job);
      // Delivery is part of the run. A report nobody received did not happen,
      // so a failure to send is a failed run rather than a quiet success.
      if (job.deliver) await this.deps.deliver(job, answer);
      await this.deps.store.recordRun(job.name, { at, status: 'ok' });
      this.log(`schedule: "${job.name}" finished`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`schedule: "${job.name}" failed — ${error}`);
      // Recorded, not disabled: a provider that was down at 02:00 is usually
      // up at 02:00 tomorrow, and silently switching a job off is worse than
      // a run that fails visibly.
      await this.deps.store.recordRun(job.name, { at, status: 'failed', error }).catch(() => {});
    }
  }
}
