import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Message, Provider } from '../providers/types.js';
import type { GatewayEvent } from './protocol.js';
import type { SessionService } from './session-service.js';

/** Bodies are a conversation, not an upload. Anything larger is a mistake. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface HttpApiDeps {
  token: string;
  providers: Provider[];
  sessions: SessionService;
  /** Subscribes to daemon events; returns the unsubscribe. */
  subscribe(handler: (sessionId: number, event: GatewayEvent) => void): () => void;
}

interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** OpenAI's error envelope, which is what clients of this API know how to read. */
function fail(res: ServerResponse, status: number, message: string, type = 'invalid_request_error'): void {
  json(res, status, { error: { message, type } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function isMessage(value: unknown): value is { role: string; content: string } {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return typeof m.role === 'string' && typeof m.content === 'string';
}

/**
 * An OpenAI-compatible front door onto the gateway.
 *
 * Callers get Robin rather than a bare model proxy: the turn runs with its
 * tools, memory and skills, and a tool call raised by an HTTP request is
 * offered to whatever terminal is attached — refused if none is, exactly as a
 * Telegram turn is. That is the point of putting this on the gateway instead of
 * standing up a second path to the providers.
 *
 * Each request gets its own session, closed when the answer is sent. The
 * endpoint is stateless by OpenAI's design — the client sends the whole
 * conversation every time — so a session that outlived the request would be a
 * conversation nobody owns cluttering `/session`.
 */
export function createHttpApi(deps: HttpApiDeps) {
  /** Turns a requested model into a provider and a model name. */
  function route(model: string): { providerId: string; model: string } | undefined {
    const wanted = model.trim();
    if (!wanted || wanted === 'robin') {
      const first = deps.providers[0];
      return first ? { providerId: first.id, model: '' } : undefined;
    }
    const slash = wanted.indexOf('/');
    const providerId = slash === -1 ? wanted : wanted.slice(0, slash);
    const provider = deps.providers.find((p) => p.id === providerId);
    if (!provider) return undefined;
    return { providerId, model: slash === -1 ? '' : wanted.slice(slash + 1) };
  }

  async function defaultModelFor(providerId: string): Promise<string> {
    const provider = deps.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error(`Unknown provider "${providerId}".`);
    const models = await provider.listModels();
    if (models.length === 0) throw new Error(`${provider.name} offers no models.`);
    return models[0];
  }

  async function listModels(res: ServerResponse): Promise<void> {
    const created = Math.floor(Date.now() / 1000);
    const entries = [{ id: 'robin', object: 'model', created, owned_by: 'robin' }];
    for (const provider of deps.providers) {
      const usable = await provider.isAuthenticated().catch(() => false);
      if (usable) {
        entries.push({ id: provider.id, object: 'model', created, owned_by: 'robin' });
      }
    }
    json(res, 200, { object: 'list', data: entries });
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: ChatRequest;
    try {
      parsed = JSON.parse(await readBody(req)) as ChatRequest;
    } catch (err) {
      fail(res, 400, `Could not read the request body: ${(err as Error).message}`);
      return;
    }

    const messages = Array.isArray(parsed.messages) ? parsed.messages.filter(isMessage) : [];
    if (messages.length === 0) {
      fail(res, 400, 'messages must be a non-empty array of {role, content}.');
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      fail(res, 400, 'messages must contain at least one user message.');
      return;
    }

    const requested = typeof parsed.model === 'string' ? parsed.model : 'robin';
    const routed = route(requested);
    if (!routed) {
      fail(res, 400, `Unknown model "${requested}". Try "robin", or "<provider>/<model>".`);
      return;
    }

    let model: string;
    try {
      model = routed.model || (await defaultModelFor(routed.providerId));
    } catch (err) {
      fail(res, 400, (err as Error).message);
      return;
    }

    const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
    // Everything before the last user message is prior conversation. It is
    // seeded rather than replayed as prompts, because the caller has already
    // had those turns — running them again would call tools twice.
    const priorHistory: Message[] = [];
    const lastUserIndex = messages.lastIndexOf(lastUser);
    for (const [index, message] of messages.entries()) {
      if (index >= lastUserIndex) break;
      if (message.role === 'system') continue;
      priorHistory.push({ role: message.role as Message['role'], content: message.content });
    }

    const session = deps.sessions.create({
      providerId: routed.providerId,
      model,
      cwd: process.cwd(),
      label: 'http',
    });
    if (system.length > 0) {
      deps.sessions.update(session.id, { systemPrompt: system.join('\n\n') });
    }
    if (priorHistory.length > 0) deps.sessions.setHistory(session.id, priorHistory);

    const streaming = parsed.stream === true;
    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    let answer = '';
    let turnId: string | undefined;

    const finished = new Promise<Extract<GatewayEvent, { kind: 'turn.finished' }>>((resolve) => {
      const stop = deps.subscribe((sessionId, event) => {
        if (sessionId !== session.id) return;
        if (event.kind === 'text') {
          answer += event.delta;
          if (streaming) {
            res.write(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: requested,
                choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
              })}\n\n`
            );
          }
        }
        if (event.kind === 'turn.finished' && event.turnId === turnId) {
          stop();
          resolve(event);
        }
      });
    });

    if (streaming) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // The first frame names the role, as OpenAI's own stream does, so a
      // client can build the message before any content arrives.
      res.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: requested,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`
      );
    }

    const accepted = deps.sessions.sendPrompt(session.id, lastUser.content, { surface: 'http' });
    turnId = accepted.turnId;
    const result = await finished;

    // Closed however the turn went: the session existed only for this request.
    deps.sessions.close(session.id);

    if (!result.ok) {
      const message = result.error ?? 'The turn failed.';
      if (streaming) {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      fail(res, 502, message, 'api_error');
      return;
    }

    if (streaming) {
      res.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          // The model that actually answered, which after a fallback is not
          // the one that was asked for. OpenAI echoes the resolved model too.
          model: result.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    json(res, 200, {
      id: completionId,
      object: 'chat.completion',
      created,
      // The model that actually answered, which after a fallback is not the one
      // that was asked for. OpenAI echoes the resolved model too.
      model: result.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: answer },
          finish_reason: 'stop',
        },
      ],
      // Robin does not count tokens. Reporting zeros is honest and keeps
      // clients that insist on the field working; inventing numbers would not.
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = (req.url ?? '').split('?')[0];

      // Same token as the WebSocket. Anything reaching this port can run
      // commands as this user, whichever protocol it speaks.
      const header = req.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (presented !== deps.token) {
        fail(res, 401, 'Missing or invalid API key.', 'invalid_api_key');
        return;
      }

      try {
        if (req.method === 'GET' && url === '/v1/models') {
          await listModels(res);
          return;
        }
        if (req.method === 'POST' && url === '/v1/chat/completions') {
          await chatCompletions(req, res);
          return;
        }
        fail(res, 404, `No route for ${req.method ?? 'GET'} ${url}.`);
      } catch (err) {
        // A handler that throws must still answer: an OpenAI client waiting on
        // a socket that simply closes reports something far less useful than a
        // 500 with a message.
        if (!res.headersSent) fail(res, 500, (err as Error).message, 'api_error');
        else res.end();
      }
    },
  };
}
