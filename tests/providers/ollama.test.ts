import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../../src/providers/ollama';

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider();
  });

  it('isAuthenticated returns true when server responds ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    expect(await provider.isAuthenticated()).toBe(true);
  });

  it('isAuthenticated returns false when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    expect(await provider.isAuthenticated()).toBe(false);
  });

  it('login throws an instructional error when server is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(provider.login()).rejects.toThrow(/ollama serve/);
  });

  it('listModels parses model names from /api/tags', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3' }, { name: 'phi3' }] }),
    }) as unknown as typeof fetch;
    expect(await provider.listModels()).toEqual(['llama3', 'phi3']);
  });

  it('chat yields streamed text events', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Hel' } }) + '\n',
      JSON.stringify({ message: { content: 'lo' } }) + '\n',
      JSON.stringify({ done: true }) + '\n',
    ];
    let i = 0;
    const encoder = new TextEncoder();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < lines.length) {
              return { done: false, value: encoder.encode(lines[i++]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    }) as unknown as typeof fetch;

    const events: { type: string; text?: string }[] = [];
    for await (const event of provider.chat('llama3', [{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
  });

  it('chat with tools uses a non-streaming request and yields tool_call events', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
      }),
    }) as unknown as typeof fetch;

    const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
    const events = [];
    for await (const event of provider.chat('llama3.1', [{ role: 'user', content: 'read a.txt' }], tools)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'tool_call', toolCall: { id: 'ollama-call-0', name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ]);
  });
});
