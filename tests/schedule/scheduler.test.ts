import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { ScheduleStore, type Job } from '../../src/schedule/store';
import { Scheduler } from '../../src/schedule/scheduler';

function at(text: string): Date {
  return new Date(text);
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    name: 'standup',
    cron: '0 9 * * *',
    prompt: 'What happened yesterday?',
    enabled: true,
    created: '2026-08-18T09:00:00Z',
    ...overrides,
  };
}

async function harness(jobs: Job[] = [job()]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-sched-run-'));
  const store = new ScheduleStore(path.join(dir, 'schedule.json'));
  for (const j of jobs) await store.put(j);

  const runJob = vi.fn().mockResolvedValue('the answer');
  const deliver = vi.fn().mockResolvedValue(undefined);
  const lines: string[] = [];

  const scheduler = new Scheduler({
    store,
    runJob,
    deliver,
    log: (line) => lines.push(line),
  });
  return { scheduler, store, runJob, deliver, lines };
}

describe('Scheduler.tick', () => {
  it('runs a job whose schedule names this minute', async () => {
    const h = await harness();
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    expect(h.runJob).toHaveBeenCalledTimes(1);
  });

  it('leaves a job alone at any other minute', async () => {
    const h = await harness();
    await h.scheduler.tick(at('2026-08-19T09:01:00'));
    expect(h.runJob).not.toHaveBeenCalled();
  });

  it('does not run a disabled job', async () => {
    const h = await harness([job({ enabled: false })]);
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    expect(h.runJob).not.toHaveBeenCalled();
  });

  it('runs a job once, however many times the minute is ticked', async () => {
    const h = await harness();
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    await h.scheduler.tick(at('2026-08-19T09:00:30'));
    await h.scheduler.tick(at('2026-08-19T09:00:59'));
    expect(h.runJob).toHaveBeenCalledTimes(1);
  });

  it('runs it again the next day', async () => {
    const h = await harness();
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    await h.scheduler.tick(at('2026-08-20T09:00:00'));
    expect(h.runJob).toHaveBeenCalledTimes(2);
  });

  // A laptop that was asleep at 02:00 should not fire the backup at 09:14.
  it('skips a run that was missed rather than firing it late', async () => {
    const h = await harness([job({ cron: '0 2 * * *' })]);
    await h.scheduler.tick(at('2026-08-19T09:14:00'));
    expect(h.runJob).not.toHaveBeenCalled();
  });

  it('records a successful run', async () => {
    const h = await harness();
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    expect(await h.store.get('standup')).toMatchObject({ lastStatus: 'ok' });
  });

  it('records why a run failed, and keeps the job for next time', async () => {
    const h = await harness();
    h.runJob.mockRejectedValue(new Error('provider unreachable'));
    await h.scheduler.tick(at('2026-08-19T09:00:00'));

    const saved = await h.store.get('standup');
    expect(saved).toMatchObject({ lastStatus: 'failed', enabled: true });
    expect(saved?.lastError).toContain('provider unreachable');
  });

  it('keeps running the other jobs when one of them throws', async () => {
    const h = await harness([
      job({ name: 'broken' }),
      job({ name: 'fine' }),
    ]);
    h.runJob.mockImplementation(async (j: Job) => {
      if (j.name === 'broken') throw new Error('boom');
      return 'ok';
    });

    await h.scheduler.tick(at('2026-08-19T09:00:00'));

    expect(h.runJob).toHaveBeenCalledTimes(2);
    expect(await h.store.get('fine')).toMatchObject({ lastStatus: 'ok' });
  });

  it('delivers the answer where the job says', async () => {
    const h = await harness([job({ deliver: { channel: 'telegram', chatId: '42' } })]);
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    expect(h.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'standup' }),
      'the answer'
    );
  });

  it('delivers nothing when the job names nowhere to send it', async () => {
    const h = await harness();
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('counts a run whose delivery failed as failed, since nobody saw the answer', async () => {
    const h = await harness([job({ deliver: { channel: 'telegram', chatId: '42' } })]);
    h.deliver.mockRejectedValue(new Error('telegram refused'));
    await h.scheduler.tick(at('2026-08-19T09:00:00'));
    expect(await h.store.get('standup')).toMatchObject({ lastStatus: 'failed' });
  });

  it('ignores a job whose schedule cannot be read, rather than failing the whole tick', async () => {
    const h = await harness();
    // Only reachable by hand-editing the file, which people do.
    await fs.writeFile(
      (h.store as unknown as { filePath: string }).filePath,
      JSON.stringify({
        version: 1,
        jobs: { broken: { cron: '@daily', prompt: 'x', enabled: true, created: 'now' } },
      }),
      'utf-8'
    );
    await expect(h.scheduler.tick(at('2026-08-19T09:00:00'))).resolves.not.toThrow();
    expect(h.runJob).not.toHaveBeenCalled();
  });
});
