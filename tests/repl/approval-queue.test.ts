import { describe, it, expect, vi } from 'vitest';
import { ApprovalQueue } from '../../src/repl/approval-queue';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ApprovalQueue', () => {
  it('runs a single enqueued render', async () => {
    const queue = new ApprovalQueue();
    const render = vi.fn().mockResolvedValue(undefined);
    queue.enqueue('a', render);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
  });

  it('does not start the second render until the first resolves', async () => {
    const queue = new ApprovalQueue();
    const first = deferred();
    const order: string[] = [];

    queue.enqueue('a', async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    queue.enqueue('b', async () => {
      order.push('b-start');
    });

    // Give the microtask queue a chance to run anything that would run early.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    first.resolve();
    await vi.waitFor(() => expect(order).toEqual(['a-start', 'a-end', 'b-start']));
  });

  it('skips rendering an entry settled elsewhere before its turn arrives', async () => {
    const queue = new ApprovalQueue();
    const first = deferred();
    const bRender = vi.fn().mockResolvedValue(undefined);
    const order: string[] = [];

    queue.enqueue('a', async () => {
      order.push('a-start');
      await first.promise;
    });
    queue.enqueue('b', bRender);

    queue.settleElsewhere('b');
    first.resolve();

    await vi.waitFor(() => expect(order).toEqual(['a-start']));
    // b never rendered.
    expect(bRender).not.toHaveBeenCalled();
  });

  it('settleElsewhere on an unknown id is a no-op', () => {
    const queue = new ApprovalQueue();
    expect(() => queue.settleElsewhere('nope')).not.toThrow();
  });

  it('a render that throws does not block the next entry', async () => {
    const queue = new ApprovalQueue();
    const order: string[] = [];

    queue.enqueue('a', async () => {
      order.push('a');
      throw new Error('boom');
    });
    queue.enqueue('b', async () => {
      order.push('b');
    });

    await vi.waitFor(() => expect(order).toEqual(['a', 'b']));
  });

  it('runs three enqueued renders strictly in order', async () => {
    const queue = new ApprovalQueue();
    const order: string[] = [];
    for (const id of ['a', 'b', 'c']) {
      queue.enqueue(id, async () => {
        order.push(id);
      });
    }
    await vi.waitFor(() => expect(order).toEqual(['a', 'b', 'c']));
  });
});
