import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { ScheduleStore } from '../../src/schedule/store';
import { AutonomyStore } from '../../src/autonomy/grant-store';
import { runMemoryNudge, DEFAULT_NUDGE_CRON, NUDGE_JOB_NAME } from '../../src/commands/memory-command';

const NOW = new Date('2026-08-20T12:00:00');

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-nudge-cmd-'));
  const lines: string[] = [];
  return {
    store: new ScheduleStore(path.join(dir, 'schedule.json')),
    autonomy: new AutonomyStore(path.join(dir, 'autonomy.json')),
    ensure: vi.fn().mockResolvedValue({ port: 18790 }),
    lines,
    out: (line: string) => lines.push(line),
    text: () => lines.join('\n').replace(/\[[0-9;]*m/g, ''),
  };
}

describe('runMemoryNudge', () => {
  it('refuses without a delivery target', async () => {
    const h = await harness();
    await expect(
      runMemoryNudge({ deliver: '' }, { ...h, now: NOW })
    ).rejects.toThrow(/deliver/i);
  });

  it('saves a job under the fixed nudge name, delivering where asked', async () => {
    const h = await harness();
    await runMemoryNudge({ deliver: 'telegram:123456789' }, { ...h, now: NOW });

    const job = await h.store.get(NUDGE_JOB_NAME);
    expect(job).toBeDefined();
    expect(job?.deliver).toEqual({ channel: 'telegram', chatId: '123456789' });
  });

  it('defaults to a weekly cron when --every is not given', async () => {
    const h = await harness();
    await runMemoryNudge({ deliver: 'telegram:123456789' }, { ...h, now: NOW });

    const job = await h.store.get(NUDGE_JOB_NAME);
    expect(job?.cron).toBe(DEFAULT_NUDGE_CRON);
  });

  it('honours a custom --every cron', async () => {
    const h = await harness();
    await runMemoryNudge({ deliver: 'telegram:123456789', every: '0 8 * * *' }, { ...h, now: NOW });

    const job = await h.store.get(NUDGE_JOB_NAME);
    expect(job?.cron).toBe('0 8 * * *');
  });

  it('writes a prompt that asks for staleness, contradictions and promotion candidates', async () => {
    const h = await harness();
    await runMemoryNudge({ deliver: 'telegram:123456789' }, { ...h, now: NOW });

    const job = await h.store.get(NUDGE_JOB_NAME);
    expect(job?.prompt).toMatch(/stale/i);
    expect(job?.prompt).toMatch(/contradict/i);
    expect(job?.prompt).toMatch(/forget|remove/i);
  });

  it('passes a manifest through when given', async () => {
    const h = await harness();
    await h.autonomy.put({
      id: 'memory-only',
      created: NOW.toISOString(),
      rules: [],
      expires: null,
    });
    await runMemoryNudge(
      { deliver: 'telegram:123456789', manifest: 'memory-only' },
      { ...h, now: NOW }
    );

    const job = await h.store.get(NUDGE_JOB_NAME);
    expect(job?.manifestId).toBe('memory-only');
  });

  it('refuses a manifest that does not exist', async () => {
    const h = await harness();
    await expect(
      runMemoryNudge(
        { deliver: 'telegram:123456789', manifest: 'nope' },
        { ...h, now: NOW }
      )
    ).rejects.toThrow(/No manifest/);
  });

  it('refuses to add a second nudge job — one nudge job exists at a time', async () => {
    const h = await harness();
    await runMemoryNudge({ deliver: 'telegram:123456789' }, { ...h, now: NOW });
    await expect(
      runMemoryNudge({ deliver: 'telegram:987654321' }, { ...h, now: NOW })
    ).rejects.toThrow(/already exists/i);
  });
});
