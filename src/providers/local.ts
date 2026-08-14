import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
import {
  toOpenAiWireMessage,
  toOpenAiToolsPayload,
  streamOpenAiCompatibleChat,
} from './openai-compatible.js';

/** llama.cpp's `llama-server` default. LM Studio uses 1234, Jan 1337. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';

/**
 * Where the local server is.
 *
 * Read at call time rather than captured at construction, so pointing Robin at
 * a different runtime is an environment variable and a new turn, not a restart.
 *
 * Both spellings of the base are accepted — llama.cpp's docs give it bare,
 * LM Studio's with the /v1 already on — because explaining which one this
 * wanted costs more than accepting either.
 */
export function defaultLocalBaseUrl(): string {
  const configured = process.env.ROBIN_LOCAL_BASE_URL?.trim();
  if (!configured) return DEFAULT_BASE_URL;
  const withoutSlash = configured.replace(/\/+$/, '');
  return withoutSlash.endsWith('/v1') ? withoutSlash : `${withoutSlash}/v1`;
}

const START_A_SERVER = [
  'No OpenAI-compatible server is answering at %URL%.',
  '',
  'Start one, then try again:',
  '  llama.cpp   llama-server -m <model.gguf> --port 8080 --jinja',
  '  LM Studio   start its local server, then ROBIN_LOCAL_BASE_URL=http://127.0.0.1:1234/v1',
  '  Jan         same, on port 1337',
  '',
  'Point Robin elsewhere with ROBIN_LOCAL_BASE_URL. A server started with its own',
  'API key wants ROBIN_LOCAL_API_KEY too.',
].join('\n');

/**
 * Any local server that speaks OpenAI's chat/completions.
 *
 * Deliberately not tied to one runtime. llama.cpp, LM Studio, Jan, KoboldCpp,
 * llamafile, vLLM and LocalAI all expose the same endpoints, so which one is
 * running is the user's business and changing it is configuration rather than
 * a code change here.
 *
 * There are no credentials to store: `isAuthenticated` asks whether anything is
 * listening, which is the only failure this provider can meaningfully report.
 */
export class LocalProvider implements Provider {
  readonly id = 'local';
  readonly name = 'Local (OpenAI-compatible)';

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // vLLM and some proxies are started with --api-key and reject anything
    // else. Servers without one must not be sent a bogus Bearer token.
    const key = process.env.ROBIN_LOCAL_API_KEY?.trim();
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const res = await fetch(`${defaultLocalBaseUrl()}/models`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async login(): Promise<void> {
    if (await this.isAuthenticated()) return;
    throw new Error(START_A_SERVER.replace('%URL%', defaultLocalBaseUrl()));
  }

  async logout(): Promise<void> {
    // No-op: a local server has no auth state of Robin's to clear.
  }

  async listModels(): Promise<string[]> {
    const baseUrl = defaultLocalBaseUrl();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/models`, { headers: this.headers() });
    } catch (err) {
      // The address is the whole diagnosis here: almost every failure is
      // "pointed at the wrong port" or "nothing running".
      throw new Error(`No local server at ${baseUrl} — ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`Failed to list models from ${baseUrl}: ${res.status}`);

    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
    // llama-server serves a single model and some builds report an empty list.
    // An empty catalogue would leave the model picker with nothing to offer and
    // no way to proceed.
    return ids.length > 0 ? ids : ['local-model'];
  }

  async *chat(
    model: string,
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent> {
    const res = await fetch(`${defaultLocalBaseUrl()}/chat/completions`, {
      method: 'POST',
      signal,
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: messages.map(toOpenAiWireMessage),
        stream: true,
        // Without this the stream carries no usage frame at all, and a turn's
        // cost is simply unknowable after the fact.
        stream_options: { include_usage: true },
        ...toOpenAiToolsPayload(tools),
      }),
    });
    yield* streamOpenAiCompatibleChat(res, 'Local server');
  }
}
