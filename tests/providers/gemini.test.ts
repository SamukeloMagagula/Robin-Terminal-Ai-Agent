import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GeminiProvider } from '../../src/providers/gemini';
import { AuthStore } from '../../src/auth-store';

describe('GeminiProvider', () => {
  let provider: GeminiProvider;
  let authStore: AuthStore;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
    authStore = new AuthStore(path.join(dir, 'auth.json'));
    provider = new GeminiProvider(authStore);
  });

  it('isAuthenticated is false with no stored key', async () => {
    expect(await provider.isAuthenticated()).toBe(false);
  });

  it('isAuthenticated is true once an API key is stored', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    expect(await provider.isAuthenticated()).toBe(true);
  });

  it('listModels throws an instructional error when not logged in', async () => {
    await expect(provider.listModels()).rejects.toThrow(/login gemini/);
  });

  it('listModels filters to models supporting generateContent and strips the "models/" prefix', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    }) as unknown as typeof fetch;

    expect(await provider.listModels()).toEqual(['gemini-1.5-flash']);
  });

  it('chat sends contents built from the message history', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    const fetchMock = sseFetchMock([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    for await (const _e of provider.chat('gemini-1.5-flash', [{ role: 'user', content: 'hi' }])) {
      // drain
    }

    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain('gemini-1.5-flash:streamGenerateContent');
    const body = JSON.parse((init as { body: string }).body) as { contents: unknown[] };
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('chat puts a system message into systemInstruction, not contents', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    const fetchMock = sseFetchMock([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    for await (const _e of provider.chat('gemini-1.5-flash', [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])) {
      // drain
    }

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      systemInstruction: { parts: { text: string }[] };
      contents: unknown[];
    };
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('chat yields streamed text events parsed from SSE', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    const chunks = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'lo' }] } }] })}\n\n`,
    ];
    global.fetch = sseFetchMock(chunks) as unknown as typeof fetch;

    const events: { type: string; text?: string }[] = [];
    for await (const event of provider.chat('gemini-1.5-flash', [{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
  });

  it('chat yields a tool_call event for a functionCall part, and sends tools as functionDeclarations', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    const chunks = [
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] } }],
      })}\n\n`,
    ];
    const fetchMock = sseFetchMock(chunks);
    global.fetch = fetchMock as unknown as typeof fetch;

    const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
    const events = [];
    for await (const event of provider.chat('gemini-1.5-flash', [{ role: 'user', content: 'read a.txt' }], tools)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      toolCall: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      tools: { functionDeclarations: { name: string }[] }[];
    };
    expect(body.tools[0].functionDeclarations[0].name).toBe('read_file');
  });

  it('chat maps an assistant tool call and its tool result into model/function turns', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    const fetchMock = sseFetchMock([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = [
      { role: 'user' as const, content: 'read a.txt' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      },
      { role: 'tool' as const, content: 'file contents', toolCallId: 'call-1' },
    ];
    for await (const _e of provider.chat('gemini-1.5-flash', history)) {
      // drain
    }

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { contents: unknown[] };
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'read a.txt' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] },
      { role: 'function', parts: [{ functionResponse: { name: 'read_file', response: { result: 'file contents' } } }] },
    ]);
  });

  it('logout clears the stored API key', async () => {
    await authStore.set('gemini', { apiKey: 'test-key' });
    await provider.logout();
    expect(await provider.isAuthenticated()).toBe(false);
  });
});

function sseFetchMock(chunks: string[]) {
  const encoder = new TextEncoder();
  return vi.fn().mockImplementation(() => {
    let i = 0;
    return Promise.resolve({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) };
            return { done: true, value: undefined };
          },
        }),
      },
    });
  });
}
