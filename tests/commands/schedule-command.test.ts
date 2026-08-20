import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { ScheduleStore } from '../../src/schedule/store';
import { AutonomyStore } from '../../src/autonomy/grant-store';
import {
  parseDelivery,
  runScheduleAdd,
  runScheduleList,
  runScheduleShow,
  runScheduleRemove,
  runScheduleEnable,
} from '../../src/commands/schedule-command';

const NOW = new Date('2026-08-18T12:00:00');

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-sched-cmd-'));
  const lines: string[] = [];
  const autonomy = new AutonomyStore(path.join(dir, 'autonomy.json'));
  await autonomy.put({
    id: 'nightly-ops',
    created: '2026-08-18T00:00:00Z',
    rules: [{ kind: 'run_command', pattern: 'git *' }],
    expires: null,
  });
  return {
    store: new ScheduleStore(path.join(dir, 'schedule.json')),
    autonomy,
    ensure: vi.fn().mockResolvedValue({ port: 18790 }),
    lines,
    out: (line: string) => lines.push(line),
    text: () => lines.join('\n').replace(/\[[0-9;]*m/g, ''),
  };
}

const options = { at: '0 9 * * 1-5', prompt: 'Summarise the day.' };

describe('parseDelivery', () => {
  it('reads a channel and a chat id', () => {
    expect(parseDelivery('telegram:123456789')).toEqual({
      channel: 'telegram',
      chatId: '123456789',
    });
  });

  it('keeps a chat id that contains a colon', () => {
    expect(parseDelivery('slack:C123:thread').chatId).toBe('C123:thread');
  });

  it.each(['telegram', ':123', 'telegram:', 'nosuch:123'])('refuses %j', (value) => {
    expect(() => parseDelivery(value)).toThrow();
  });

  it('refuses a channel that exists but is not implemented', () => {
    expect(() => parseDelivery('teams:123')).toThrow(/not wired up/i);
  });

  it('reads an email address as a destination', () => {
    expect(parseDelivery('email:you@example.com')).toEqual({
      channel: 'email',
      chatId: 'you@example.com',
    });
  });

  it('refuses an email destination that is not an address', () => {
    expect(() => parseDelivery('email:not-an-address')).toThrow(/not-an-address/);
  });

  it('names both channels and email when the destination makes no sense', () => {
    expect(() => parseDelivery('nosuch:1')).toThrow(/email/);
  });
});

describe('robin schedule add', () => {
  it('saves the job', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    expect(await h.store.get('standup')).toMatchObject({
      cron: '0 9 * * 1-5',
      prompt: 'Summarise the day.',
      enabled: true,
    });
  });

  it('starts the gateway, since a job only fires while it is running', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    expect(h.ensure).toHaveBeenCalled();
  });

  it('refuses a schedule it cannot read, and saves nothing', async () => {
    const h = await harness();
    await expect(
      runScheduleAdd('standup', { ...options, at: '@daily' }, { ...h, now: NOW })
    ).rejects.toThrow();
    expect(await h.store.list()).toEqual([]);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('refuses a manifest that does not exist', async () => {
    const h = await harness();
    await expect(
      runScheduleAdd('standup', { ...options, manifest: 'ghost' }, { ...h, now: NOW })
    ).rejects.toThrow(/ghost/);
  });

  it('accepts a manifest that does', async () => {
    const h = await harness();
    await runScheduleAdd('standup', { ...options, manifest: 'nightly-ops' }, { ...h, now: NOW });
    expect((await h.store.get('standup'))?.manifestId).toBe('nightly-ops');
  });

  it('warns when there is no manifest, because tool calls will be refused', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    expect(h.text()).toMatch(/no manifest/i);
  });

  it('says nothing about manifests when one was given', async () => {
    const h = await harness();
    await runScheduleAdd('standup', { ...options, manifest: 'nightly-ops' }, { ...h, now: NOW });
    expect(h.text()).not.toMatch(/tool calls will be refused/i);
  });

  it('refuses an empty prompt', async () => {
    const h = await harness();
    await expect(
      runScheduleAdd('standup', { ...options, prompt: '   ' }, { ...h, now: NOW })
    ).rejects.toThrow(/prompt/i);
  });

  it('refuses to overwrite an existing job', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    await expect(runScheduleAdd('standup', options, { ...h, now: NOW })).rejects.toThrow(
      /already exists/i
    );
  });

  it('tells you when it will first run', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    expect(h.text()).toMatch(/first run/i);
  });
});

describe('robin schedule list', () => {
  it('says so plainly when there are none', async () => {
    const h = await harness();
    await runScheduleList(h.store, h.out, NOW);
    expect(h.text()).toMatch(/no scheduled jobs/i);
  });

  it('shows a failed run, which is the thing worth noticing', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    await h.store.recordRun('standup', {
      at: '2026-08-19T09:00:00Z',
      status: 'failed',
      error: 'provider unreachable',
    });
    h.lines.length = 0;
    await runScheduleList(h.store, h.out, NOW);
    expect(h.text()).toContain('provider unreachable');
  });
});

describe('robin schedule show / remove / enable', () => {
  it('shows the prompt and where the answer goes', async () => {
    const h = await harness();
    await runScheduleAdd(
      'standup',
      { ...options, deliver: 'telegram:42' },
      { ...h, now: NOW }
    );
    h.lines.length = 0;
    await runScheduleShow(h.store, 'standup', h.out, NOW);
    expect(h.text()).toContain('Summarise the day.');
    expect(h.text()).toContain('telegram:42');
  });

  it('refuses to show a job that does not exist', async () => {
    const h = await harness();
    await expect(runScheduleShow(h.store, 'ghost', h.out, NOW)).rejects.toThrow(/ghost/);
  });

  it('removes a job', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    await runScheduleRemove(h.store, 'standup', h.out);
    expect(await h.store.get('standup')).toBeUndefined();
  });

  it('disables a job without forgetting it', async () => {
    const h = await harness();
    await runScheduleAdd('standup', options, { ...h, now: NOW });
    await runScheduleEnable(h.store, 'standup', false, h.out);
    expect(await h.store.get('standup')).toMatchObject({ enabled: false, prompt: 'Summarise the day.' });
  });
});
