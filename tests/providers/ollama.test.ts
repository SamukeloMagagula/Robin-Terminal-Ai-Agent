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

  it('chat with tools still streams, yielding text then tool_call events', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Let me look. ' } }) + '\n',
      JSON.stringify({
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
      }) + '\n',
      JSON.stringify({ done: true }) + '\n',
    ];
    const fetchMock = streamingFetchMock(lines);
    global.fetch = fetchMock as unknown as typeof fetch;

    const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
    const events = [];
    for await (const event of provider.chat('llama3.1', [{ role: 'user', content: 'read a.txt' }], tools)) {
      events.push(event);
    }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { stream: boolean; tools: unknown[] };
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', text: 'Let me look. ' });
    expect(events[1]).toMatchObject({
      type: 'tool_call',
      toolCall: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    });
  });

  it('generates a unique tool-call id for every call across rounds', async () => {
    const ids: string[] = [];
    const chunk =
      JSON.stringify({
        message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
      }) + '\n';

    for (let round = 0; round < 2; round++) {
      global.fetch = streamingFetchMock([chunk]) as unknown as typeof fetch;
      for await (const event of provider.chat('llama3.1', [{ role: 'user', content: 'go' }])) {
        if (event.type === 'tool_call') ids.push(event.toolCall.id);
      }
    }

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('serializes toolCalls/toolCallId history into Ollama wire format', async () => {
    const fetchMock = streamingFetchMock([JSON.stringify({ message: { content: 'ok' } }) + '\n']);
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = [
      { role: 'user' as const, content: 'read a.txt' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      },
      { role: 'tool' as const, content: 'hello world', toolCallId: 'call-1' },
    ];
    for await (const _event of provider.chat('llama3.1', history)) {
      // drain
    }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { messages: Record<string, unknown>[] };
    expect(body.messages).toEqual([
      { role: 'user', content: 'read a.txt' },
      {
        role: 'assistant',
        content: '',
        // Ollama wants arguments as an object, not a JSON string.
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
      },
      { role: 'tool', content: 'hello world', tool_call_id: 'call-1' },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain('toolCall');
  });
});

function streamingFetchMock(lines: string[]) {
  const encoder = new TextEncoder();
  return vi.fn().mockImplementation(() => {
    let i = 0;
    return Promise.resolve({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < lines.length) return { done: false, value: encoder.encode(lines[i++]) };
            return { done: true, value: undefined };
          },
        }),
      },
    });
  });
}
