import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleClear } from '../../../src/repl/commands/conversation';
import type { ReplContext } from '../../../src/repl/repl-context';
import { startHarness, type GatewayHarness } from '../../helpers/gateway-harness';

let harness: GatewayHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
});

async function context(): Promise<ReplContext> {
  harness = await startHarness();
  harness.sessions.append(harness.session.id, { role: 'user', content: 'something' });
  return {
    client: harness.client,
    sessionId: harness.session.id,
    snapshot: harness.session,
  } as unknown as ReplContext;
}

describe('handleClear', () => {
  it('empties the conversation the gateway holds', async () => {
    const ctx = await context();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleClear(ctx);

    expect(harness?.sessions.history(ctx.sessionId)).toEqual([]);
  });

  it('resets the turn count with the conversation', async () => {
    const ctx = await context();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleClear(ctx);

    // The memory nudge exists to catch what was learned in *this* exchange, so
    // carrying the count across a clear would fire it on turn one of an
    // unrelated one.
    expect(ctx.snapshot.turnCount).toBe(0);
  });

  it('wipes the visible screen and the scrollback', async () => {
    const ctx = await context();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await handleClear(ctx);

    const written = write.mock.calls.map((c) => String(c[0])).join('');
    // 2J clears the screen, 3J clears the scrollback buffer, H homes the
    // cursor. Without 3J the old conversation is still one scroll away.
    expect(written).toContain('\x1b[2J');
    expect(written).toContain('\x1b[3J');
    expect(written).toContain('\x1b[H');
  });
});
