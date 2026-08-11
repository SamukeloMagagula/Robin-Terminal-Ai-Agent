import { describe, it, expect, vi } from 'vitest';
import { handleClear } from '../../../src/repl/commands/conversation';
import { createSession } from '../../../src/repl/session';
import type { ReplContext } from '../../../src/repl/repl-context';
import type { Provider } from '../../../src/providers/types';

function context() {
  const session = createSession({ id: 'x', name: 'X' } as unknown as Provider, 'm');
  session.history.push({ role: 'user', content: 'something' });
  return { session, ctx: { session } as unknown as ReplContext };
}

describe('handleClear', () => {
  it('empties the conversation history', async () => {
    const { ctx, session } = context();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleClear(ctx);

    expect(session.history).toEqual([]);
    write.mockRestore();
    vi.restoreAllMocks();
  });

  it('wipes the visible screen and the scrollback', async () => {
    const { ctx } = context();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleClear(ctx);

    const written = write.mock.calls.map((c) => String(c[0])).join('');
    // 2J clears the screen, 3J clears the scrollback buffer, H homes the
    // cursor. Without 3J the old conversation is still one scroll away.
    expect(written).toContain('\x1b[2J');
    expect(written).toContain('\x1b[3J');
    expect(written).toContain('\x1b[H');

    write.mockRestore();
    vi.restoreAllMocks();
  });
});
