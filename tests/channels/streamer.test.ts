import { describe, it, expect, vi } from 'vitest';
import { createReplyStream, EDIT_INTERVAL_MS } from '../../src/channels/streamer';
import type { ChannelTransport } from '../../src/channels/types';

function transport(options: { canEdit?: boolean } = {}) {
  const sent: string[] = [];
  const edits: string[] = [];
  const t = {
    id: 'fake',
    name: 'Fake',
    connect: vi.fn(),
    receive: vi.fn(),
    send: vi.fn(async (_chatId: string, text: string) => {
      sent.push(text);
      return 'm1';
    }),
  } as unknown as ChannelTransport;
  if (options.canEdit !== false) {
    (t as { edit?: unknown }).edit = vi.fn(async (_c: string, _m: string, text: string) => {
      edits.push(text);
    });
  }
  return { t, sent, edits };
}

/** A clock the test moves, so throttling is tested without waiting. */
function clock() {
  let value = 0;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

describe('createReplyStream', () => {
  it('posts something immediately, so the wait is visible', async () => {
    const { t, sent } = transport();
    const stream = createReplyStream(t, 'c1');

    await stream.push('partial');

    expect(sent).toHaveLength(1);
  });

  it('posts only once however many chunks arrive', async () => {
    const { t, sent } = transport();
    const time = clock();
    const stream = createReplyStream(t, 'c1', time.now);

    await stream.push('a');
    await stream.push('ab');
    await stream.push('abc');

    expect(sent).toHaveLength(1);
  });

  // An edit per token would hit the per-channel rate limit within a sentence,
  // after which the whole bridge is throttled — not just the streaming.
  it('does not edit more often than the interval allows', async () => {
    const { t, edits } = transport();
    const time = clock();
    const stream = createReplyStream(t, 'c1', time.now);

    await stream.push('a');
    await stream.push('ab');
    await stream.push('abc');

    expect(edits).toHaveLength(0);
  });

  it('edits once the interval has passed', async () => {
    const { t, edits } = transport();
    const time = clock();
    const stream = createReplyStream(t, 'c1', time.now);

    await stream.push('a');
    time.advance(EDIT_INTERVAL_MS + 1);
    await stream.push('a longer answer');

    expect(edits).toEqual(['a longer answer']);
  });

  it('writes the final text on finish', async () => {
    const { t, edits } = transport();
    const time = clock();
    const stream = createReplyStream(t, 'c1', time.now);

    await stream.push('half');
    await stream.finish('the whole answer');

    expect(edits.at(-1)).toBe('the whole answer');
  });

  it('does not edit again when the last edit already said it', async () => {
    const { t, edits } = transport();
    const time = clock();
    const stream = createReplyStream(t, 'c1', time.now);

    await stream.push('done');
    time.advance(EDIT_INTERVAL_MS + 1);
    await stream.push('done');
    await stream.finish('done');

    expect(edits).toEqual(['done']);
  });

  it('never leaves an empty reply', async () => {
    const { t, edits } = transport();
    const stream = createReplyStream(t, 'c1');

    await stream.push('');
    await stream.finish('');

    expect(edits.at(-1)).toBe('(no reply)');
  });

  // A transport that cannot edit is not broken, it just cannot stream.
  it('sends once at the end when the transport cannot edit', async () => {
    const { t, sent } = transport({ canEdit: false });
    const stream = createReplyStream(t, 'c1');

    await stream.push('half');
    await stream.push('most');
    await stream.finish('the whole answer');

    expect(sent).toEqual(['the whole answer']);
  });

  it('falls back to a new message when the final edit fails', async () => {
    const { t, sent } = transport();
    const time = clock();
    (t.edit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('too long to edit'));
    const stream = createReplyStream(t, 'c1', time.now);

    await stream.push('half');
    await stream.finish('the whole answer');

    // The placeholder, then the answer as its own message: the reply arrives
    // either way.
    expect(sent).toContain('the whole answer');
  });

  it('does not fail the turn when an intermediate edit fails', async () => {
    const { t } = transport();
    const time = clock();
    (t.edit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rate limited'));
    const stream = createReplyStream(t, 'c1', time.now);

    await stream.push('a');
    time.advance(EDIT_INTERVAL_MS + 1);

    await expect(stream.push('ab')).resolves.toBeUndefined();
  });
});
