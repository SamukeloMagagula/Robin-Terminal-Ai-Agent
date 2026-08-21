import { describe, it, expect, vi } from 'vitest';
import { handleUsage } from '../../../src/repl/commands/info';
import type { ReplContext } from '../../../src/repl/repl-context';
import type { UsageEntry } from '../../../src/usage/usage-log';

function ctxWith(entries: UsageEntry[], openRouterUsage: unknown = null): ReplContext {
  return {
    stores: {
      usage: { get: vi.fn().mockResolvedValue(openRouterUsage) },
      usageLog: { readAll: vi.fn().mockResolvedValue(entries) },
    },
  } as unknown as ReplContext;
}

describe('handleUsage', () => {
  it('prints the local report even when OpenRouter usage is unavailable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const entry: UsageEntry = {
      ts: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.0006,
    };

    await handleUsage(ctxWith([entry]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('anthropic');
    logSpy.mockRestore();
  });

  it('says nothing has been recorded yet on a fresh profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleUsage(ctxWith([]));

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('No usage recorded yet');
    logSpy.mockRestore();
  });
});
