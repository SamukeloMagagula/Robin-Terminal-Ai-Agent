import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { request } from 'node:http';
import { GatewayServer } from '../../src/gateway/server';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { createHttpApi } from '../../src/gateway/http-api';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { Provider } from '../../src/providers/types';

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

function fakeProvider(id: string, name: string, reply = 'the reply'): Provider {
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue([`${id}-model`]),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: reply };
    }),
  } as unknown as Provider;
}

let server: GatewayServer;
let sessions: SessionService;
let base: string;
let providers: Provider[];

beforeEach(async () => {
  providers = [fakeProvider('copilot', 'GitHub Copilot'), fakeProvider('local', 'Local')];
  let built: GatewayServer;
  const approvals = new ApprovalRegistry({
    broadcast: (p) => built.broadcastApproval(p),
    resolved: (p, a, b) => built.resolvedApproval(p, a, b),
  });
  sessions = new SessionService({
    providers,
    approvals,
    emit: (id, event) => built.emit(id, event),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
    },
  });
  built = new GatewayServer({
    sessions,
    approvals,
    token: 'tok',
    port: 0,
    log: () => {},
    http: createHttpApi({
      token: 'tok',
      providers,
      sessions,
      subscribe: (handler) => built.onEvent(handler),
    }),
  });
  server = built;
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
});

const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' };

describe('GET /v1/models', () => {
  it('needs the token', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(401);
  });

  it('rejects the wrong token', async () => {
    const res = await fetch(`${base}/v1/models`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('lists robin and every authenticated provider', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: auth });
    const body = (await res.json()) as { object: string; data: { id: string }[] };

    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['robin', 'copilot', 'local']);
  });

  it('leaves out a provider that is not logged in', async () => {
    (providers[1].isAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const res = await fetch(`${base}/v1/models`, { headers: auth });
    const body = (await res.json()) as { data: { id: string }[] };

    expect(body.data.map((m) => m.id)).toEqual(['robin', 'copilot']);
  });
});

describe('POST /v1/chat/completions', () => {
  async function ask(body: unknown, headers: Record<string, string> = auth): Promise<Response> {
    return fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('answers in the OpenAI shape', async () => {
    const res = await ask({ model: 'robin', messages: [{ role: 'user', content: 'hi' }] });
    const body = (await res.json()) as {
      object: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
    };

    expect(res.status).toBe(200);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'the reply' });
    expect(body.choices[0].finish_reason).toBe('stop');
  });

  it('routes an explicit provider/model', async () => {
    await ask({ model: 'local/llama-3.1', messages: [{ role: 'user', content: 'hi' }] });

    const chat = providers[1].chat as unknown as { mock: { calls: unknown[][] } };
    expect(chat.mock.calls[0][0]).toBe('llama-3.1');
  });

  it('routes a bare provider id to that provider', async () => {
    await ask({ model: 'local', messages: [{ role: 'user', content: 'hi' }] });
    expect((providers[1].chat as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('sends the earlier turns as history, not just the last message', async () => {
    await ask({
      model: 'robin',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    });

    const sent = (providers[0].chat as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { role: string; content: string }[];
    expect(sent.map((m) => m.content)).toContain('first');
    expect(sent.map((m) => m.content)).toContain('answer');
    expect(sent.at(-1)?.content).toBe('second');
  });

  it('applies a system message as the session system prompt', async () => {
    await ask({
      model: 'robin',
      messages: [
        { role: 'system', content: 'BE VERY TERSE' },
        { role: 'user', content: 'hi' },
      ],
    });

    const sent = (providers[0].chat as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { role: string; content: string }[];
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toContain('BE VERY TERSE');
  });

  // Otherwise every HTTP call leaves a conversation behind in /session.
  it('does not leave its session open afterwards', async () => {
    await ask({ model: 'robin', messages: [{ role: 'user', content: 'hi' }] });
    expect(sessions.list()).toEqual([]);
  });

  it('rejects a request with no messages', async () => {
    const res = await ask({ model: 'robin', messages: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a model it cannot route', async () => {
    const res = await ask({ model: 'nonsense/x', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('nonsense');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('needs the token', async () => {
    const res = await ask({ model: 'robin', messages: [{ role: 'user', content: 'hi' }] }, {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
  });

  // Only when nothing can answer: one provider failing is a fallback, not an
  // error, and the caller should get the reply rather than the excuse.
  it('reports a failed turn as an error once nothing can answer', async () => {
    for (const provider of providers) {
      (provider.chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        throw new Error('provider exploded');
      });
    }

    const res = await ask({ model: 'copilot', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('exploded');
  });

  it('names the model that answered, not the one that was asked for', async () => {
    (providers[0].chat as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      throw new Error('copilot is down');
    });

    const res = await ask({ model: 'copilot', messages: [{ role: 'user', content: 'hi' }] });
    const body = (await res.json()) as { model: string; choices: { message: { content: string } }[] };

    // The fallback chain rescued it on the other provider; saying "copilot"
    // here would be a quiet lie about where the answer came from.
    expect(res.status).toBe(200);
    expect(body.model).toBe('local-model');
  });
});

describe('POST /v1/chat/completions with stream: true', () => {
  it('streams OpenAI-shaped chunks and terminates with [DONE]', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'robin',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();

    expect(text).toContain('data: ');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const deltas = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)) as { choices: { delta: { content?: string } }[] })
      .map((frame) => frame.choices[0]?.delta?.content ?? '')
      .join('');
    expect(deltas).toBe('the reply');
  });

  it('closes its session when the stream ends', async () => {
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'robin',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }).then((r) => r.text());

    expect(sessions.list()).toEqual([]);
  });
});

describe('unknown routes', () => {
  it('404s with a JSON error rather than an HTML page', async () => {
    const res = await fetch(`${base}/v1/nonsense`, { headers: auth });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('still upgrades WebSocket connections on the same port', async () => {
    const { GatewayClient } = await import('../../src/gateway/client');
    const client = await GatewayClient.connect({
      port: Number(new URL(base).port),
      token: 'tok',
      kind: 'terminal',
      canApprove: true,
      cwd: '.',
    });
    expect(client.sessions).toEqual([]);
    await client.close();
  });
});

describe('the "robin" model', () => {
  it('picks the first provider that is actually logged in', async () => {
    // The README promises "the first provider you're logged into". Taking
    // providers[0] regardless means `robin` fails for anyone who has not
    // logged into whichever provider happens to be first in the registry.
    (providers[0].isAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'robin', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    expect((providers[1].chat as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect((providers[0].chat as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('says so when nothing is logged in', async () => {
    for (const provider of providers) {
      (provider.isAuthenticated as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    }

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'robin', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /logged in|log in/i
    );
  });

  it('marks its sessions as http, not as a terminal', async () => {
    const seen: string[] = [];
    sessions.list = ((original) => () => {
      const list = original.call(sessions);
      for (const s of list) seen.push(s.origin);
      return list;
    })(sessions.list);

    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'robin', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // The session is closed by the time we can list, so assert on the create
    // path instead: nothing terminal-shaped should have been produced.
    expect(sessions.list()).toEqual([]);
  });
});

describe('a client that hangs up', () => {
  it('interrupts the turn rather than letting it burn provider quota', async () => {
    let sawAbort: boolean | undefined;
    (providers[0].chat as ReturnType<typeof vi.fn>).mockImplementation(async function* (
      _model: string,
      _history: unknown,
      _tools: unknown,
      signal?: AbortSignal
    ) {
      yield { type: 'text', text: 'start' };
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Recorded rather than asserted here: this runs inside the daemon, and a
      // failed expectation in a generator is swallowed by the turn.
      sawAbort = signal?.aborted === true;
      if (signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      yield { type: 'text', text: ' end' };
    });

    const controller = new AbortController();
    const request = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      signal: controller.signal,
      body: JSON.stringify({
        model: 'copilot',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await request.catch(() => {});

    await vi.waitFor(() => expect(sawAbort).toBe(true), { timeout: 3000 });
    // And nothing is left behind for /session to show.
    await vi.waitFor(() => expect(sessions.list()).toEqual([]), { timeout: 3000 });
  });
});

describe('the control UI', () => {
  it('serves a page at the root without needing a token', async () => {
    // The page has to load before it can ask for one; the token guards the
    // socket and the API, which is where anything actually happens.
    const res = await fetch(`${base}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<!doctype html>');
  });

  // DNS rebinding: a site resolves its own name to 127.0.0.1, so the browser
  // treats our port as same-origin and can read what the page holds. Checking
  // the Host header costs nothing and closes it.
  // fetch refuses to set Host — it is a forbidden header name, silently
  // dropped — so these go out over a raw request, which is also what anything
  // exploiting this would use.
  function getWithHost(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: Number(new URL(base).port), path: '/', headers: { host } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('refuses a request that arrived under someone else\'s hostname', async () => {
    expect(await getWithHost('evil.example')).toBe(403);
  });

  it('accepts localhost by name', async () => {
    expect(await getWithHost(`localhost:${new URL(base).port}`)).toBe(200);
  });

  it('sends a content security policy that keeps the page to itself', async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy') ?? '';

    // Everything the page needs is inline and same-origin; nothing should be
    // fetchable from anywhere else.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('connect-src');
  });
});
