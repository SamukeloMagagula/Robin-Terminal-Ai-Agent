import { describe, it, expect } from 'vitest';
import { isRequest, isNotification, isResponse } from '../../src/acp/jsonrpc';

describe('isRequest', () => {
  it('accepts a message with jsonrpc, id and method', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toBe(true);
  });

  it('accepts a string id', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 'abc', method: 'initialize' })).toBe(true);
  });

  it('rejects a message with no id (a notification)', () => {
    expect(isRequest({ jsonrpc: '2.0', method: 'session/cancel', params: {} })).toBe(false);
  });

  it('rejects a message with no method', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 1 })).toBe(false);
  });

  it('rejects a response (has result, no method)', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
  });
});

describe('isNotification', () => {
  it('accepts a message with method and no id', () => {
    expect(isNotification({ jsonrpc: '2.0', method: 'session/cancel', params: {} })).toBe(true);
  });

  it('rejects a message with an id (a request)', () => {
    expect(isNotification({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(false);
  });

  it('rejects a message with no method', () => {
    expect(isNotification({ jsonrpc: '2.0' })).toBe(false);
  });
});

describe('isResponse', () => {
  it('accepts a success response (has result and id)', () => {
    expect(isResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toBe(true);
  });

  it('accepts an error response (has error and id)', () => {
    expect(isResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'nope' } })).toBe(true);
  });

  it('rejects a message with a method (a request)', () => {
    expect(isResponse({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(false);
  });

  it('rejects a message with neither result nor error', () => {
    expect(isResponse({ jsonrpc: '2.0', id: 1 })).toBe(false);
  });
});
