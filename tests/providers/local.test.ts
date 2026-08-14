import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalProvider, defaultLocalBaseUrl } from '../../src/providers/local';

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, body, status: 200 } as unknown as Response;
}

async function drain(events: AsyncIterable<{ type: string }>): Promise<{ type: string }[]> {
  const seen = [];
  for await (const event of events) seen.push(event);
  return seen;
}

const originalUrl = process.env.ROBIN_LOCAL_BASE_URL;
const originalKey = process.env.ROBIN_LOCAL_API_KEY;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.ROBIN_LOCAL_BASE_URL;
  else process.env.ROBIN_LOCAL_BASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.ROBIN_LOCAL_API_KEY;
  else process.env.ROBIN_LOCAL_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe('defaultLocalBaseUrl', () => {
  it('is llama.cpp\'s default port', () => {
    delete process.env.ROBIN_LOCAL_BASE_URL;
    expect(defaultLocalBaseUrl()).toBe('http://127.0.0.1:8080/v1');
  });

  it('honours ROBIN_LOCAL_BASE_URL', () => {
    process.env.ROBIN_LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1';
    expect(defaultLocalBaseUrl()).toBe('http://127.0.0.1:1234/v1');
  });

  // LM Studio's own docs give the base as .../v1, llama.cpp's as bare. Accepting
  // both spellings is cheaper than explaining which one this wanted.
  it('adds the /v1 suffix when it was left off', () => {
    process.env.ROBIN_LOCAL_BASE_URL = 'http://127.0.0.1:1234';
    expect(defaultLocalBaseUrl()).toBe('http://127.0.0.1:1234/v1');
  });

  it('ignores a trailing slash', () => {
    process.env.ROBIN_LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1/';
    expect(defaultLocalBaseUrl()).toBe('http://127.0.0.1:1234/v1');
  });
});

describe('LocalProvider', () => {
  // "Authenticated" for a local server means reachable. There are no
  // credentials to hold, and a server nobody is running is the only failure
  // this can meaningfully report.
  it('is authenticated when something answers /models', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    expect(await new LocalProvider().isAuthenticated()).toBe(true);
  });

  it('is not authenticated when nothing is listening', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    expect(await new LocalProvider().isAuthenticated()).toBe(false);
  });

  it('lists the models the server reports', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'llama-3.1-8b' }, { id: 'qwen2.5-coder' }] }),
    }) as unknown as typeof fetch;

    expect(await new LocalProvider().listModels()).toEqual(['llama-3.1-8b', 'qwen2.5-coder']);
  });

  // llama-server serves one model and some builds report an empty list. An
  // empty catalogue would leave the picker with nothing to choose.
  it('falls back to a placeholder when the server names no models', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;

    expect(await new LocalProvider().listModels()).toEqual(['local-model']);
  });

  it('says where it looked when the server is unreachable', async () => {
    process.env.ROBIN_LOCAL_BASE_URL = 'http://127.0.0.1:9999/v1';
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    await expect(new LocalProvider().listModels()).rejects.toThrow(/9999/);
  });

  it('login explains how to start a server rather than asking for a key', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    await expect(new LocalProvider().login()).rejects.toThrow(/llama-server|LM Studio/i);
  });

  it('login succeeds silently when a server is already up', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    await expect(new LocalProvider().login()).resolves.toBeUndefined();
  });

  it('streams text from an OpenAI-compatible response', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n',
        'data: [DONE]\n',
      ])
    ) as unknown as typeof fetch;

    const events = await drain(
      new LocalProvider().chat('llama-3.1-8b', [{ role: 'user', content: 'hi' }])
    );

    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
    ]);
  });

  it('sends tools in the OpenAI shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n']));
    global.fetch = fetchMock as unknown as typeof fetch;

    await drain(
      new LocalProvider().chat('m', [{ role: 'user', content: 'hi' }], [
        { name: 'run_command', description: 'runs', parameters: { type: 'object' } },
      ])
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.tools[0].function.name).toBe('run_command');
    expect(body.stream).toBe(true);
  });

  it('sends no authorization header when no key is configured', async () => {
    delete process.env.ROBIN_LOCAL_API_KEY;
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n']));
    global.fetch = fetchMock as unknown as typeof fetch;

    await drain(new LocalProvider().chat('m', [{ role: 'user', content: 'hi' }]));

    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBeUndefined();
  });

  // vLLM and some proxies are started with --api-key and reject anything else.
  it('sends the key when ROBIN_LOCAL_API_KEY is set', async () => {
    process.env.ROBIN_LOCAL_API_KEY = 'secret';
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n']));
    global.fetch = fetchMock as unknown as typeof fetch;

    await drain(new LocalProvider().chat('m', [{ role: 'user', content: 'hi' }]));

    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer secret');
  });

  it('reads the base URL at call time, so the env var can change mid-session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n']));
    global.fetch = fetchMock as unknown as typeof fetch;
    const provider = new LocalProvider();

    process.env.ROBIN_LOCAL_BASE_URL = 'http://127.0.0.1:4321/v1';
    await drain(provider.chat('m', [{ role: 'user', content: 'hi' }]));

    expect(String(fetchMock.mock.calls[0][0])).toContain('4321');
  });
});
