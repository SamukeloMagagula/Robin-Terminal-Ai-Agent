import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import {
  ChatRequestError,
  isModelUnsupported,
  isProviderQuotaExhausted,
} from '../../src/providers/chat-error';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-unsupported-'));
  file = path.join(dir, 'unsupported-models.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('isModelUnsupported', () => {
  it('recognises the code GitHub Copilot returns', () => {
    expect(
      isModelUnsupported(
        new ChatRequestError('nope', { status: 400, code: 'model_not_supported' })
      )
    ).toBe(true);
  });

  it('recognises model_not_found', () => {
    expect(
      isModelUnsupported(new ChatRequestError('nope', { status: 404, code: 'model_not_found' }))
    ).toBe(true);
  });

  // A rate limit is transient — recording it would permanently hide a working model.
  it('does not treat a rate limit as unsupported', () => {
    expect(
      isModelUnsupported(new ChatRequestError('slow down', { status: 429, code: 'rate_limited' }))
    ).toBe(false);
  });

  it('does not treat a bare 400 as unsupported', () => {
    expect(isModelUnsupported(new ChatRequestError('bad', { status: 400 }))).toBe(false);
  });

  it('ignores ordinary errors and non-errors', () => {
    expect(isModelUnsupported(new Error('model_not_supported'))).toBe(false);
    expect(isModelUnsupported(null)).toBe(false);
    expect(isModelUnsupported('model_not_supported')).toBe(false);
  });

  // Google reports 404 with error.status "NOT_FOUND" and a *number* in
  // error.code, so the OpenAI-shaped string check found nothing.
  it('treats a 404 as a permanently missing model', () => {
    expect(
      isModelUnsupported(
        new ChatRequestError('gone', {
          status: 404,
          code: 'NOT_FOUND',
          serverMessage: 'This model models/gemini-2.5-flash is no longer available to new users.',
        })
      )
    ).toBe(true);
  });

  it('recognises a 404 even with no code at all', () => {
    expect(isModelUnsupported(new ChatRequestError('gone', { status: 404 }))).toBe(true);
  });

  // Real Gemini response: permanent, but a bare 400 with no distinguishing code.
  it('recognises "only supports Interactions API" as permanent', () => {
    expect(
      isModelUnsupported(
        new ChatRequestError('nope', {
          status: 400,
          serverMessage: 'This model only supports Interactions API.',
        })
      )
    ).toBe(true);
  });

  it('recognises "no longer available" as permanent', () => {
    expect(
      isModelUnsupported(
        new ChatRequestError('nope', {
          status: 400,
          serverMessage: 'This model is no longer available to new users.',
        })
      )
    ).toBe(true);
  });

  it('does not treat an unrecognised 400 message as permanent', () => {
    expect(
      isModelUnsupported(
        new ChatRequestError('nope', { status: 400, serverMessage: 'Invalid JSON payload.' })
      )
    ).toBe(false);
  });

  // Quota messages sometimes mention models; they must never be recorded.
  it('never records a 429 however it is worded', () => {
    expect(
      isModelUnsupported(
        new ChatRequestError('slow', {
          status: 429,
          code: 'RESOURCE_EXHAUSTED',
          serverMessage: 'Quota exceeded — model not supported on the free tier.',
        })
      )
    ).toBe(false);
  });

  it('never records a server fault', () => {
    expect(
      isModelUnsupported(
        new ChatRequestError('boom', { status: 503, serverMessage: 'model not supported' })
      )
    ).toBe(false);
  });
});

describe('isProviderQuotaExhausted', () => {
  it('is true for a rate limit and for exhausted credit', () => {
    expect(isProviderQuotaExhausted(new ChatRequestError('x', { status: 429 }))).toBe(true);
    expect(isProviderQuotaExhausted(new ChatRequestError('x', { status: 402 }))).toBe(true);
  });

  it('is false for model and server problems', () => {
    expect(isProviderQuotaExhausted(new ChatRequestError('x', { status: 404 }))).toBe(false);
    expect(isProviderQuotaExhausted(new ChatRequestError('x', { status: 400 }))).toBe(false);
    expect(isProviderQuotaExhausted(new ChatRequestError('x', { status: 500 }))).toBe(false);
  });

  it('ignores non-ChatRequestError values', () => {
    expect(isProviderQuotaExhausted(new Error('429'))).toBe(false);
    expect(isProviderQuotaExhausted(null)).toBe(false);
  });
});

describe('UnsupportedModelStore', () => {
  it('starts empty', async () => {
    const store = new UnsupportedModelStore(file);
    expect(await store.listFor('copilot')).toEqual([]);
  });

  it('records and persists across instances', async () => {
    await new UnsupportedModelStore(file).record('copilot', 'claude-opus-5');
    expect(await new UnsupportedModelStore(file).listFor('copilot')).toEqual(['claude-opus-5']);
  });

  it('does not duplicate a repeated recording', async () => {
    const store = new UnsupportedModelStore(file);
    await store.record('copilot', 'claude-opus-5');
    await store.record('copilot', 'claude-opus-5');
    expect(await store.listFor('copilot')).toEqual(['claude-opus-5']);
  });

  it('keeps providers separate', async () => {
    const store = new UnsupportedModelStore(file);
    await store.record('copilot', 'claude-opus-5');
    await store.record('gemini', 'gemini-9');
    expect(await store.listFor('copilot')).toEqual(['claude-opus-5']);
    expect(await store.listFor('gemini')).toEqual(['gemini-9']);
  });

  it('filters a catalogue while preserving order', async () => {
    const store = new UnsupportedModelStore(file);
    await store.record('copilot', 'claude-opus-5');
    await store.record('copilot', 'gpt-5.4');
    expect(await store.filter('copilot', ['gpt-4o', 'claude-opus-5', 'gpt-4.1', 'gpt-5.4'])).toEqual(
      ['gpt-4o', 'gpt-4.1']
    );
  });

  it('leaves other providers catalogues untouched', async () => {
    const store = new UnsupportedModelStore(file);
    await store.record('copilot', 'gpt-4o');
    expect(await store.filter('gemini', ['gpt-4o'])).toEqual(['gpt-4o']);
  });

  it('clear forgets a provider so its catalogue is retried', async () => {
    const store = new UnsupportedModelStore(file);
    await store.record('copilot', 'claude-opus-5');
    await store.clear('copilot');
    expect(await store.listFor('copilot')).toEqual([]);
  });

  // A broken memo must never stop the user chatting.
  it('treats a corrupt file as empty', async () => {
    await fs.writeFile(file, 'not json at all');
    const store = new UnsupportedModelStore(file);
    expect(await store.listFor('copilot')).toEqual([]);
    expect(await store.filter('copilot', ['gpt-4o'])).toEqual(['gpt-4o']);
  });

  it('treats a wrong-shaped file as empty', async () => {
    await fs.writeFile(file, JSON.stringify({ copilot: 'should-be-an-array' }));
    expect(await new UnsupportedModelStore(file).listFor('copilot')).toEqual([]);
  });

  it('does not throw when the path is unwritable', async () => {
    const store = new UnsupportedModelStore(path.join(dir, 'nested', 'deep', 'file.json'));
    await expect(store.record('copilot', 'x')).resolves.toBeUndefined();
  });
});
