const ESC = 0x1b;

interface Interruptible {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
  pause?: () => unknown;
}

export interface Interrupt {
  signal: AbortSignal;
  /** Always call this when the turn ends, or the terminal stays in raw mode. */
  dispose: () => void;
}

/**
 * Listens for Esc while a reply is streaming, and aborts the turn.
 *
 * The prompt is not active during a turn — readSlashAwareLine has already
 * resolved — so this owns stdin for the duration and hands it back on dispose.
 *
 * Esc is also bound inside the prompt (slash-prompt.ts, closing the command
 * popup). The two never overlap: that listener exists only while input is
 * being accepted, this one only while a reply streams.
 *
 * Ctrl-C is deliberately untouched and still quits.
 *
 * Raw bytes rather than readline's keypress events, deliberately: readline
 * holds a lone ESC for 500ms to see whether it is the start of an escape
 * sequence, and half a second of lag on an interrupt key is the difference
 * between "it stopped" and "did that work?". A chunk of exactly one ESC byte
 * is a bare Esc; arrow keys and the like arrive as longer sequences that begin
 * with ESC, so they do not match.
 */
export function listenForInterrupt(stdin: Interruptible = process.stdin): Interrupt {
  const controller = new AbortController();

  // Piped input and test harnesses have no raw mode. An inert signal keeps
  // every caller on one code path.
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return { signal: controller.signal, dispose: () => {} };
  }

  stdin.setRawMode(true);

  const onData = (chunk: Buffer): void => {
    if (chunk.length === 1 && chunk[0] === ESC) controller.abort();
  };
  stdin.on('data', onData);

  return {
    signal: controller.signal,
    dispose: () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      // Attaching a data listener put the stream in flowing mode. Pause it so
      // keystrokes typed during the reply are not delivered to the next
      // prompt; the prompt's own readline resumes it.
      stdin.pause?.();
    },
  };
}
