import { describe, it, expect, vi } from 'vitest';
import { runUsage } from '../../src/commands/usage-command';
import type { UsageLog, UsageEntry } from '../../src/usage/usage-log';

function fakeLog(entries: UsageEntry[]): UsageLog {
  return { readAll: vi.fn().mockResolvedValue(entries) } as unknown as UsageLog;
}

describe('runUsage', () => {
  it('prints the local usage report', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const entry: UsageEntry = {
      ts: new Date().toISOString(),
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputTokens: 200,
      outputTokens: 40,
      estimatedCostUsd: 0.0002,
    };

    await runUsage(fakeLog([entry]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('gemini');
    logSpy.mockRestore();
  });

  it('says so plainly when nothing has been recorded', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUsage(fakeLog([]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('No usage recorded yet');
    logSpy.mockRestore();
  });
});
