import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { ScheduleStore, isValidJobName, type Job } from '../../src/schedule/store';

async function store(): Promise<{ store: ScheduleStore; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-schedule-'));
  const file = path.join(dir, 'schedule.json');
  return { store: new ScheduleStore(file), file };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    name: 'standup',
    cron: '0 9 * * 1-5',
    prompt: "Summarise yesterday's commits.",
    enabled: true,
    created: '2026-08-18T09:00:00Z',
    ...overrides,
  };
}

describe('isValidJobName', () => {
  it.each(['standup', 'nightly-backup', 'a_b.c', 'x1'])('accepts %j', (name) => {
    expect(isValidJobName(name)).toBe(true);
  });

  it.each(['', '.', '..', 'has space', 'slash/name', 'back\\slash', 'quote"'])(
    'refuses %j',
    (name) => {
      expect(isValidJobName(name)).toBe(false);
    }
  );
});

describe('ScheduleStore', () => {
  it('has no jobs to begin with', async () => {
    const { store: s } = await store();
    expect(await s.list()).toEqual([]);
  });

  it('round-trips a job', async () => {
    const { store: s } = await store();
    await s.put(job());
    expect(await s.get('standup')).toEqual(job());
  });

  it('lists jobs by name', async () => {
    const { store: s } = await store();
    await s.put(job({ name: 'b' }));
    await s.put(job({ name: 'a' }));
    expect((await s.list()).map((j) => j.name)).toEqual(['a', 'b']);
  });

  it('refuses a job whose schedule it cannot read, rather than storing one that never fires', async () => {
    const { store: s } = await store();
    await expect(s.put(job({ cron: '@daily' }))).rejects.toThrow();
    expect(await s.list()).toEqual([]);
  });

  it('refuses a name that could name a path', async () => {
    const { store: s } = await store();
    await expect(s.put(job({ name: '../escape' }))).rejects.toThrow();
  });

  it('removes a job', async () => {
    const { store: s } = await store();
    await s.put(job());
    expect(await s.remove('standup')).toBe(true);
    expect(await s.get('standup')).toBeUndefined();
  });

  it('reports false when removing a job that was never there', async () => {
    const { store: s } = await store();
    expect(await s.remove('ghost')).toBe(false);
  });

  it('records what happened on the last run', async () => {
    const { store: s } = await store();
    await s.put(job());
    await s.recordRun('standup', { at: '2026-08-19T09:00:00Z', status: 'ok' });
    expect(await s.get('standup')).toMatchObject({
      lastRun: '2026-08-19T09:00:00Z',
      lastStatus: 'ok',
    });
  });

  it('keeps the reason a run failed, which is the thing worth reading later', async () => {
    const { store: s } = await store();
    await s.put(job());
    await s.recordRun('standup', {
      at: '2026-08-19T09:00:00Z',
      status: 'failed',
      error: 'provider unreachable',
    });
    expect((await s.get('standup'))?.lastError).toBe('provider unreachable');
  });

  it('clears a previous error when a later run succeeds', async () => {
    const { store: s } = await store();
    await s.put(job());
    await s.recordRun('standup', { at: '1', status: 'failed', error: 'boom' });
    await s.recordRun('standup', { at: '2', status: 'ok' });
    expect((await s.get('standup'))?.lastError).toBeUndefined();
  });

  it('treats a damaged file as no jobs, rather than running something half-read', async () => {
    const { store: s, file } = await store();
    await fs.writeFile(file, '{ not json', 'utf-8');
    expect(await s.list()).toEqual([]);
  });

  it('drops a single malformed job and keeps the readable ones', async () => {
    const { store: s, file } = await store();
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        jobs: { good: { ...job(), name: undefined }, bad: { cron: 5 } },
      }),
      'utf-8'
    );
    expect((await s.list()).map((j) => j.name)).toEqual(['good']);
  });
});
