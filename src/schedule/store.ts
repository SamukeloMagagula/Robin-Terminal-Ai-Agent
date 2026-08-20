/**
 * Scheduled jobs, in ~/.robin/schedule.json.
 *
 * Fails closed like the autonomy store, and for a sharper reason: these jobs
 * run unattended. A half-understood file must produce no jobs rather than a
 * job whose schedule or prompt was misread — the failure mode of running the
 * wrong thing at 02:00 with nobody watching is worse than not running at all.
 * One malformed job is dropped on its own, so the rest still fire.
 *
 * The schedule is stored exactly as it was typed and parsed on the way in, so
 * a job that could never fire cannot be saved in the first place.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { UserFacingError } from '../startup/bootstrap.js';
import { parseCron } from './cron.js';
import { robinHome } from '../profile.js';

export interface JobDelivery {
  /** A channel id, e.g. "telegram". */
  channel: string;
  /** Where in that channel the answer goes. */
  chatId: string;
}

export interface Job {
  name: string;
  /** The cron expression as written, so `schedule list` can show it back. */
  cron: string;
  /** What Robin is asked when it fires. */
  prompt: string;
  enabled: boolean;
  created: string;
  /** The capability manifest the run acts under, if any. */
  manifestId?: string;
  /** Where the answer is sent. Absent means it is only recorded. */
  deliver?: JobDelivery;
  /** Falls back to the gateway's defaults when absent. */
  providerId?: string;
  model?: string;
  lastRun?: string;
  lastStatus?: 'ok' | 'failed';
  lastError?: string;
}

type StoredJob = Omit<Job, 'name'>;

interface ScheduleFile {
  version: 1;
  jobs: Record<string, StoredJob>;
}

export function defaultSchedulePath(): string {
  return path.join(robinHome(), 'schedule.json');
}

/** A job name becomes a key and appears in log lines; it must not name a path. */
export function isValidJobName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function isStoredJob(value: unknown): value is StoredJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as StoredJob;
  return (
    typeof job.cron === 'string' &&
    typeof job.prompt === 'string' &&
    typeof job.enabled === 'boolean' &&
    typeof job.created === 'string'
  );
}

export interface RunResult {
  at: string;
  status: 'ok' | 'failed';
  error?: string;
}

export class ScheduleStore {
  constructor(private readonly filePath: string = defaultSchedulePath()) {}

  private async read(): Promise<Record<string, StoredJob>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const file = parsed as Partial<ScheduleFile>;
      if (file.version !== 1) return {};
      const { jobs } = file;
      if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return {};

      const out: Record<string, StoredJob> = {};
      for (const [name, job] of Object.entries(jobs)) {
        if (isValidJobName(name) && isStoredJob(job)) out[name] = job;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async write(jobs: Record<string, StoredJob>): Promise<void> {
    const data: ScheduleFile = { version: 1, jobs };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  }

  async get(name: string): Promise<Job | undefined> {
    const found = (await this.read())[name];
    return found ? { name, ...found } : undefined;
  }

  async list(): Promise<Job[]> {
    return Object.entries(await this.read())
      .map(([name, job]) => ({ name, ...job }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Validates before storing: a job that can never fire is not worth keeping. */
  async put(job: Job): Promise<void> {
    if (!isValidJobName(job.name)) {
      throw new UserFacingError(
        `"${job.name}" is not a usable job name. Use letters, numbers, dot, dash and underscore.`
      );
    }
    // Throws with the reason, which is the whole point of checking here rather
    // than discovering it at 02:00 when nothing happens.
    parseCron(job.cron);

    const { name, ...rest } = job;
    const jobs = await this.read();
    jobs[name] = rest;
    await this.write(jobs);
  }

  async remove(name: string): Promise<boolean> {
    const jobs = await this.read();
    if (!(name in jobs)) return false;
    delete jobs[name];
    await this.write(jobs);
    return true;
  }

  /**
   * Records the outcome of a run.
   *
   * A success clears the previous error: leaving it would make a job that
   * recovered look permanently broken in `schedule list`.
   */
  async recordRun(name: string, result: RunResult): Promise<void> {
    const jobs = await this.read();
    const existing = jobs[name];
    if (!existing) return;
    jobs[name] = {
      ...existing,
      lastRun: result.at,
      lastStatus: result.status,
      ...(result.status === 'failed' && result.error
        ? { lastError: result.error }
        : { lastError: undefined }),
    };
    await this.write(jobs);
  }
}
