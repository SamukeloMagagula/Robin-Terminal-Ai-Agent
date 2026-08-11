import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { listenForInterrupt } from '../../src/repl/interrupt';

function fakeTty() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (v: boolean) => unknown;
  };
  s.isTTY = true;
  s.setRawMode = vi.fn();
  return s;
}

const settle = () => new Promise((r) => setImmediate(r));

describe('listenForInterrupt', () => {
  it('aborts when Esc is pressed', async () => {
    const stdin = fakeTty();
    const { signal, dispose } = listenForInterrupt(stdin);

    stdin.write('\x1b');
    await settle();

    expect(signal.aborted).toBe(true);
    dispose();
  });

  it('ignores ordinary keys', async () => {
    const stdin = fakeTty();
    const { signal, dispose } = listenForInterrupt(stdin);

    stdin.write('a');
    await settle();

    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('ignores escape sequences that merely begin with ESC, such as arrow keys', async () => {
    const stdin = fakeTty();
    const { signal, dispose } = listenForInterrupt(stdin);

    stdin.write('\x1b[A');
    await settle();

    expect(signal.aborted).toBe(false);
    dispose();
  });

  it('restores raw mode and removes its listener on dispose', async () => {
    const stdin = fakeTty();
    const { signal, dispose } = listenForInterrupt(stdin);
    dispose();

    stdin.write('\x1b');
    await settle();

    expect(signal.aborted).toBe(false);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  it('is inert without a TTY, rather than throwing', async () => {
    const stdin = new PassThrough() as never;
    const { signal, dispose } = listenForInterrupt(stdin);

    expect(signal.aborted).toBe(false);
    expect(() => dispose()).not.toThrow();
  });
});
