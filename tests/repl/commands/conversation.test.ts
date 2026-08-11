import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { handleSave, handleLoad, handleCopy } from '../../../src/repl/commands/conversation';
import { createSession, type Session } from '../../../src/repl/session';
import { ConversationStore } from '../../../src/conversation-store';
import type { ReplContext } from '../../../src/repl/repl-context';
import type { Provider } from '../../../src/providers/types';

function fakeProvider(): Provider {
  return { id: 'copilot', name: 'GitHub Copilot' } as unknown as Provider;
}

/**
 * A context with only the pieces these handlers touch. Building the real thing
 * would need four live stores; the cast keeps the test honest about what is
 * actually exercised.
 */
async function tempContext(): Promise<{ ctx: ReplContext; session: Session }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-cmd-'));
  const session = createSession(fakeProvider(), 'gpt-4o');
  const ctx = {
    session,
    inputHistory: [],
    stores: { conversation: new ConversationStore(dir) },
  } as unknown as ReplContext;
  return { ctx, session };
}

describe('handleSave / handleLoad', () => {
  it('round-trips the active session history through a named slot', async () => {
    const { ctx, session } = await tempContext();
    session.history.push({ role: 'user', content: 'remember me' });

    await handleSave(ctx, 'slot1');
    session.history = [];
    await handleLoad(ctx, 'slot1');

    expect(ctx.session.history).toEqual([{ role: 'user', content: 'remember me' }]);
  });

  it('rejects a slot name that could escape the conversations directory', async () => {
    const { ctx } = await tempContext();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleSave(ctx, '../escape');

    expect(log.mock.calls.flat().join(' ')).toMatch(/Invalid conversation name/);
    log.mockRestore();
  });
});

describe('handleCopy', () => {
  it('says there is nothing to copy on an empty session', async () => {
    const { ctx } = await tempContext();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCopy(ctx);

    expect(log.mock.calls.flat().join(' ')).toMatch(/Nothing to copy/);
    log.mockRestore();
  });
});
