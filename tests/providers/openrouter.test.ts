import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { OpenRouterProvider } from '../../src/providers/openrouter';
import { AuthStore } from '../../src/auth-store';

describe('OpenRouterProvider', () => {
  let provider: OpenRouterProvider;
  let authStore: AuthStore;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrouter-test-'));
    authStore = new AuthStore(path.join(dir, 'auth.json'));
    provider = new OpenRouterProvider(authStore);
  });

  it('isAuthenticated is false with no stored key', async () => {
    expect(await provider.isAuthenticated()).toBe(false);
  });

  it('isAuthenticated is true once an API key is stored', async () => {
    await authStore.set('openrouter', { apiKey: 'sk-or-test' });
    expect(await provider.isAuthenticated()).toBe(true);
  });

  it('listModels does not require auth and maps ids from the response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-3.5-sonnet' }] }),
    }) as unknown as typeof fetch;

    expect(await provider.listModels()).toEqual(['openai/gpt-4o', 'anthropic/claude-3.5-sonnet']);
  });

  it('chat throws an instructional error when not logged in', async () => {
    await expect(
      (async () => {
        for await (const _e of provider.chat('openai/gpt-4o', [{ role: 'user', content: 'hi' }])) {
          // drain
        }
      })()
    ).rejects.toThrow(/login openrouter/);
  });

  it('chat streams content deltas parsed from SSE', async () => {
    await authStore.set('openrouter', { apiKey: 'sk-or-test' });
    const encoder = new TextEncoder();
    const sseLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' there' } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const fetchMock = vi.fn().mockImplementation(() => {
      let i = 0;
      return Promise.resolve({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (i < sseLines.length) return { done: false, value: encoder.encode(sseLines[i++]) };
              return { done: true, value: undefined };
            },
          }),
        },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const events: { type: string; text?: string }[] = [];
    for await (const event of provider.chat('openai/gpt-4o', [{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'text', text: ' there' },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer sk-or-test');
  });

  it('sends tools as OpenAI-style function declarations', async () => {
    await authStore.set('openrouter', { apiKey: 'sk-or-test' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const tools = [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
    for await (const _e of provider.chat('openai/gpt-4o', [{ role: 'user', content: 'hi' }], tools)) {
      // drain
    }

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      tools: { type: string; function: { name: string } }[];
    };
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } } },
    ]);
  });

  it('logout clears the stored API key', async () => {
    await authStore.set('openrouter', { apiKey: 'sk-or-test' });
    await provider.logout();
    expect(await provider.isAuthenticated()).toBe(false);
  });
});
