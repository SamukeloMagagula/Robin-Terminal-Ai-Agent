import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { handleSave, handleLoad, handleCopy } from '../../../src/repl/commands/conversation';
import { ConversationStore } from '../../../src/conversation-store';
import type { ReplContext } from '../../../src/repl/repl-context';
import { startHarness, type GatewayHarness } from '../../helpers/gateway-harness';

let harness: GatewayHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
});

/**
 * A context with only the pieces these handlers touch, over a real gateway.
 * The cast keeps the test honest about what is actually exercised.
 */
async function tempContext(): Promise<ReplContext> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-cmd-'));
  harness = await startHarness();
  return {
    client: harness.client,
    sessionId: harness.session.id,
    snapshot: harness.session,
    inputHistory: [],
    stores: { conversation: new ConversationStore(dir) },
  } as unknown as ReplContext;
}

describe('handleSave / handleLoad', () => {
  it('round-trips the session history through a named slot', async () => {
    const ctx = await tempContext();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    harness?.sessions.append(ctx.sessionId, { role: 'user', content: 'remember me' });

    await handleSave(ctx, 'slot1');
    harness?.sessions.setHistory(ctx.sessionId, []);
    await handleLoad(ctx, 'slot1');

    expect(harness?.sessions.history(ctx.sessionId)).toEqual([
      { role: 'user', content: 'remember me' },
    ]);
  });

  it('saves what the gateway holds, not a stale local copy', async () => {
    const ctx = await tempContext();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Written after the context was built: a handler reading a cached history
    // would miss this.
    harness?.sessions.append(ctx.sessionId, { role: 'user', content: 'added later' });

    await handleSave(ctx, 'slot2');

    const saved = await ctx.stores.conversation.load('slot2');
    expect(saved.messages).toEqual([{ role: 'user', content: 'added later' }]);
  });

  it('rejects a slot name that could escape the conversations directory', async () => {
    const ctx = await tempContext();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleSave(ctx, '../escape');

    expect(log.mock.calls.flat().join(' ')).toMatch(/Invalid conversation name/);
  });
});

describe('handleCopy', () => {
  it('says there is nothing to copy on an empty session', async () => {
    const ctx = await tempContext();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCopy(ctx);

    expect(log.mock.calls.flat().join(' ')).toMatch(/Nothing to copy/);
  });
});
