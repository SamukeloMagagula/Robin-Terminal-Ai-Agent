import { describe, it, expect } from 'vitest';
import { parseFrame, PROTOCOL_VERSION } from '../../src/gateway/protocol';

describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('parseFrame', () => {
  it('reads a request frame', () => {
    const frame = parseFrame('{"type":"req","id":"1","method":"session.list","params":{}}');
    expect(frame).toEqual({ type: 'req', id: '1', method: 'session.list', params: {} });
  });

  it('reads a successful response frame', () => {
    const frame = parseFrame('{"type":"res","id":"1","ok":true,"result":{"sessions":[]}}');
    expect(frame).toEqual({ type: 'res', id: '1', ok: true, result: { sessions: [] } });
  });

  it('reads a failed response frame', () => {
    const frame = parseFrame('{"type":"res","id":"1","ok":false,"error":{"code":"x","message":"y"}}');
    expect(frame).toMatchObject({ type: 'res', ok: false, error: { code: 'x' } });
  });

  it('reads an event frame', () => {
    const raw = '{"type":"event","sessionId":1,"event":{"kind":"text","turnId":"t1","delta":"hi"}}';
    expect(parseFrame(raw)).toMatchObject({ type: 'event', sessionId: 1 });
  });

  // A frame arrives from a socket. Anything can be on the other end of a
  // socket, and a malformed frame must not take the daemon down.
  it.each([
    'not json',
    '[]',
    'null',
    '{"type":"nope"}',
    '{"type":"req"}',
    '{"type":"req","id":1,"method":"x","params":{}}',
    '{"type":"req","id":"1","method":"x"}',
    '{"type":"res","id":"1"}',
    '{"type":"res","id":"1","ok":false}',
    '{"type":"event"}',
    '{"type":"event","event":{}}',
  ])('rejects %s', (raw) => {
    expect(parseFrame(raw)).toBeUndefined();
  });
});
