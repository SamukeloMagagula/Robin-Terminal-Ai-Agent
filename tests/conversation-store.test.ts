import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConversationStore, isValidConversationName, type SavedConversation } from '../src/conversation-store';

describe('isValidConversationName', () => {
  it('accepts letters, numbers, dots, dashes, underscores', () => {
    expect(isValidConversationName('my-chat_v2.1')).toBe(true);
  });

  it('rejects path separators', () => {
    expect(isValidConversationName('../secrets')).toBe(false);
    expect(isValidConversationName('a/b')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidConversationName('')).toBe(false);
  });
});

describe('ConversationStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-store-test-'));
  });

  function sample(): SavedConversation {
    return {
      providerId: 'ollama',
      providerName: 'Ollama (local)',
      model: 'llama3.1:latest',
      savedAt: '2026-08-06T00:00:00.000Z',
      messages: [{ role: 'user', content: 'hi' }],
    };
  }

  it('returns an empty list when nothing is saved', async () => {
    const store = new ConversationStore(dir);
    expect(await store.list()).toEqual([]);
  });

  it('round-trips a conversation through save/load', async () => {
    const store = new ConversationStore(dir);
    await store.save('my-chat', sample());
    expect(await store.load('my-chat')).toEqual(sample());
  });

  it('lists saved conversation names, sorted', async () => {
    const store = new ConversationStore(dir);
    await store.save('b-chat', sample());
    await store.save('a-chat', sample());
    expect(await store.list()).toEqual(['a-chat', 'b-chat']);
  });

  it('rejects an invalid name on save', async () => {
    const store = new ConversationStore(dir);
    await expect(store.save('../escape', sample())).rejects.toThrow(/Invalid conversation name/);
  });

  it('rejects an invalid name on load', async () => {
    const store = new ConversationStore(dir);
    await expect(store.load('../escape')).rejects.toThrow(/Invalid conversation name/);
  });

  it('throws when loading a name that was never saved', async () => {
    const store = new ConversationStore(dir);
    await expect(store.load('missing')).rejects.toThrow();
  });
});
