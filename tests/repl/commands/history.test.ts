import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleHistory } from '../../../src/repl/commands/history';
import { robinHome } from '../../../src/profile';
import type { ReplContext } from '../../../src/repl/repl-context';

const originalProfile = process.env.ROBIN_PROFILE;
const originalNoHistory = process.env.ROBIN_NO_HISTORY_FILE;

afterEach(() => {
  if (originalProfile === undefined) delete process.env.ROBIN_PROFILE;
  else process.env.ROBIN_PROFILE = originalProfile;
  if (originalNoHistory === undefined) delete process.env.ROBIN_NO_HISTORY_FILE;
  else process.env.ROBIN_NO_HISTORY_FILE = originalNoHistory;
  vi.restoreAllMocks();
});

function context(): ReplContext {
  return { inputHistory: [] } as unknown as ReplContext;
}

describe('handleHistory', () => {
  it('prints the path under the current profile, not the bare default', async () => {
    delete process.env.ROBIN_NO_HISTORY_FILE;
    process.env.ROBIN_PROFILE = `history-test-${Date.now()}`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHistory(context());

    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain(robinHome());
  });
});
