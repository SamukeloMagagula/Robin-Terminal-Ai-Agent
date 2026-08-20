import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { createStdioTransport } from '../../src/acp/transport';

function fakeStreams() {
  const input = new Readable({ read() {} });
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  return { input, output, written };
}

describe('createStdioTransport', () => {
  it('parses one JSON object per line and delivers each to the handler', async () => {
    const { input, output } = fakeStreams();
    const transport = createStdioTransport(input, output);
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    input.push('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    input.push('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
    ]);
  });

  it('drops a malformed line rather than throwing', async () => {
    const { input, output } = fakeStreams();
    const transport = createStdioTransport(input, output);
    const received: unknown[] = [];
    const handler = vi.fn((msg) => received.push(msg));
    transport.onMessage(handler);

    input.push('not json at all\n');
    input.push('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
  });

  it('handles a message split across two chunks', async () => {
    const { input, output } = fakeStreams();
    const transport = createStdioTransport(input, output);
    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg));

    input.push('{"jsonrpc":"2.0","id":1,');
    input.push('"method":"initialize","params":{}}\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
  });

  it('writes each sent message as one line, newline-terminated', () => {
    const { input, output, written } = fakeStreams();
    const transport = createStdioTransport(input, output);

    transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });

    expect(written).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n']);
  });

  it('fires onClose when the input stream ends', async () => {
    const { input, output } = fakeStreams();
    const transport = createStdioTransport(input, output);
    const closed = vi.fn();
    transport.onClose(closed);

    input.push(null); // end of stream

    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('writes nothing but transport output to the output stream', () => {
    const { input, output, written } = fakeStreams();
    const transport = createStdioTransport(input, output);
    transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    transport.send({ jsonrpc: '2.0', id: 2, result: {} });
    expect(written.every((line) => line.endsWith('\n'))).toBe(true);
    expect(written.every((line) => (line.match(/\n/g) ?? []).length === 1)).toBe(true);
  });
});
