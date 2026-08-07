import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSafeBrowserUrl } from '../src/browser';
import { parseCommand } from '../src/repl/parse-command';
import { ConversationStore, isSavedConversation } from '../src/conversation-store';
import { defaultChatLogDir } from '../src/chat-log';

describe('isSafeBrowserUrl', () => {
  it('accepts ordinary https URLs', () => {
    expect(isSafeBrowserUrl('https://github.com/login/device')).toBe(true);
    expect(isSafeBrowserUrl('http://localhost:8080/callback?code=abc123')).toBe(true);
  });

  // These are the payloads that mattered: the URL reaches a shell on Windows.
  it.each([
    'https://evil.test/x&calc',
    'https://evil.test/x|whoami',
    'https://evil.test/x^y',
    'https://evil.test/a b',
    'https://evil.test/x\ncalc',
    'https://evil.test/x`id`',
  ])('rejects %s', (url) => {
    expect(isSafeBrowserUrl(url)).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(isSafeBrowserUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeBrowserUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects nonsense', () => {
    expect(isSafeBrowserUrl('not a url')).toBe(false);
    expect(isSafeBrowserUrl('')).toBe(false);
  });
});

describe('parseCommand inherited-property lookup', () => {
  it.each(['/toString', '/constructor', '/__proto__', '/valueOf', '/hasOwnProperty'])(
    'reports %s as unknown rather than silently swallowing it',
    (input) => {
      expect(parseCommand(input)).toEqual({ type: 'unknown', arg: input });
    }
  );

  it('still resolves real commands', () => {
    expect(parseCommand('/help')).toEqual({ type: 'help', arg: undefined });
  });
});

describe('isSavedConversation', () => {
  it('accepts a well-formed save', () => {
    expect(
      isSavedConversation({
        providerId: 'p',
        providerName: 'P',
        model: 'm',
        savedAt: 'now',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).toBe(true);
  });

  it.each([
    ['a message with no content', { messages: [{ role: 'user' }] }],
    ['a non-string content', { messages: [{ role: 'user', content: 42 }] }],
    ['an unknown role', { messages: [{ role: 'root', content: 'x' }] }],
    ['messages that are not an array', { messages: 'nope' }],
  ])('rejects %s', (_label, partial) => {
    expect(isSavedConversation({ providerName: 'P', model: 'm', ...partial })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isSavedConversation(null)).toBe(false);
    expect(isSavedConversation('a string')).toBe(false);
  });
});

describe('ConversationStore.load', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-conv-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('refuses a tampered save file instead of loading it into history', async () => {
    await fs.writeFile(path.join(tmp, 'bad.json'), JSON.stringify({ messages: [{ role: 'x' }] }));
    const store = new ConversationStore(tmp);
    await expect(store.load('bad')).rejects.toThrow('not a valid saved conversation');
  });
});

describe('chat transcript location', () => {
  it('is inside the private .robin tree, not Downloads', () => {
    const dir = defaultChatLogDir();
    expect(dir).toBe(path.join(os.homedir(), '.robin', 'chats'));
    expect(dir).not.toContain('Downloads');
  });
});
