/**
 * Newline-delimited JSON over stdio — ACP's wire format, confirmed against
 * the ACPex reference implementation's own description of the transport
 * ("Transport Layer — Newline-delimited JSON over stdio").
 *
 * Nothing but transport output may ever reach the output stream: the editor
 * parses it line by line, and a stray diagnostic line would corrupt its read
 * of the next real message. Anything the bridge needs to log goes to stderr.
 */
export interface AcpTransport {
  /** Delivers one parsed message per call. A malformed line is dropped, not fatal. */
  onMessage(handler: (msg: Record<string, unknown>) => void): void;
  send(msg: Record<string, unknown>): void;
  /**
   * Fires once the input stream ends or closes — the editor exited, or its
   * end of the pipe went away. Without this, anything waiting on an answer
   * that can now never arrive (a permission request, in particular) hangs
   * forever instead of failing.
   */
  onClose(handler: () => void): void;
  close(): void;
}

export function createStdioTransport(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): AcpTransport {
  let buffer = '';
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let closed = false;

  const onStreamClosed = (): void => {
    if (closed) return;
    closed = true;
    closeHandler?.();
  };
  input.on('end', onStreamClosed);
  input.on('close', onStreamClosed);

  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let newlineIndex: number;
    // A message can arrive split across chunks, so lines are only extracted
    // once a full newline-terminated one is in the buffer — the rest waits
    // for more data rather than being parsed early and failing.
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // Malformed input is a dropped line, not a crashed process.
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        handler?.(parsed as Record<string, unknown>);
      }
    }
  };

  input.on('data', onData);

  return {
    onMessage(h) {
      handler = h;
    },
    send(msg) {
      output.write(`${JSON.stringify(msg)}\n`);
    },
    onClose(h) {
      closeHandler = h;
    },
    close() {
      input.off('data', onData);
      input.off('end', onStreamClosed);
      input.off('close', onStreamClosed);
    },
  };
}
