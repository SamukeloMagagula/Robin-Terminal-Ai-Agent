import { describe, it, expect, vi } from 'vitest';
import { deliverJob } from '../../src/schedule/deliver';
import type { Job } from '../../src/schedule/store';

function job(overrides: Partial<Job> = {}): Job {
  return {
    name: 'standup',
    cron: '0 9 * * *',
    prompt: 'x',
    enabled: true,
    created: '2026-08-18T09:00:00Z',
    ...overrides,
  };
}

describe('deliverJob', () => {
  it('does nothing when the job names nowhere', async () => {
    const toChannel = vi.fn();
    const toEmail = vi.fn();
    await deliverJob(job(), 'the answer', { toChannel, toEmail });
    expect(toChannel).not.toHaveBeenCalled();
    expect(toEmail).not.toHaveBeenCalled();
  });

  it('sends to a chat channel when the job names one', async () => {
    const toChannel = vi.fn().mockResolvedValue(undefined);
    const toEmail = vi.fn();
    await deliverJob(job({ deliver: { channel: 'telegram', chatId: '42' } }), 'the answer', {
      toChannel,
      toEmail,
    });
    expect(toChannel).toHaveBeenCalledWith('telegram', '42', expect.stringContaining('the answer'));
    expect(toEmail).not.toHaveBeenCalled();
  });

  it('sends mail when the job names an address', async () => {
    const toChannel = vi.fn();
    const toEmail = vi.fn().mockResolvedValue(undefined);
    await deliverJob(
      job({ deliver: { channel: 'email', chatId: 'you@example.com' } }),
      'the answer',
      { toChannel, toEmail }
    );
    expect(toEmail).toHaveBeenCalledWith('you@example.com', 'standup', 'the answer');
    expect(toChannel).not.toHaveBeenCalled();
  });

  it('names the job in a chat message, since a chat carries no subject line', async () => {
    const toChannel = vi.fn().mockResolvedValue(undefined);
    await deliverJob(job({ deliver: { channel: 'telegram', chatId: '42' } }), 'the answer', {
      toChannel,
      toEmail: vi.fn(),
    });
    expect(toChannel.mock.calls[0][2]).toContain('standup');
  });

  it('does not repeat the job name in the mail body, which has it as the subject', async () => {
    const toEmail = vi.fn().mockResolvedValue(undefined);
    await deliverJob(
      job({ deliver: { channel: 'email', chatId: 'you@example.com' } }),
      'the answer',
      { toChannel: vi.fn(), toEmail }
    );
    expect(toEmail.mock.calls[0][2]).toBe('the answer');
  });
});
