import { randomUUID } from 'node:crypto';
import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
import { describeChatError, extractErrorCode, extractServerMessage } from './http-error.js';
import { ChatRequestError } from './chat-error.js';

const BASE_URL = 'http://localhost:11434';

interface TagsResponse {
  models: { name: string }[];
}

interface WireMessage {
  role: Message['role'];
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_call_id?: string;
}

/**
 * Translate an internal camelCase `Message` into the shape Ollama's /api/chat expects.
 * Note Ollama wants tool-call `arguments` as an object, not the JSON string we carry
 * internally, so we parse it back here (the inverse of what `chat` does on receive).
 */
function toWireMessage(message: Message): WireMessage {
  const wire: WireMessage = { role: message.role, content: message.content };
  if (message.toolCalls && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((tc) => ({
      function: { name: tc.name, arguments: parseArguments(tc.arguments) },
    }));
  }
  if (message.toolCallId) wire.tool_call_id = message.toolCallId;
  return wire;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';

  async isAuthenticated(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE_URL}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async login(): Promise<void> {
    const ok = await this.isAuthenticated();
    if (!ok) {
      throw new Error(
        'Ollama is not reachable at http://localhost:11434.\n' +
          'Start it with `ollama serve`, or install it from https://ollama.com if needed.'
      );
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/api/tags`);
    if (!res.ok) throw new Error(`Failed to list Ollama models: ${res.status}`);
    const data = (await res.json()) as TagsResponse;
    return data.models.map((m) => m.name);
  }

  async *chat(
    model: string,
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent> {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messages.map(toWireMessage),
        stream: true,
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => undefined);
      throw new ChatRequestError(describeChatError('Ollama', res.status, body), {
        status: res.status,
        code: extractErrorCode(body),
        serverMessage: extractServerMessage(body),
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as {
          message?: {
            content?: string;
            tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
          };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        // Ollama puts the counts on the final line, alongside done: true.
        if (
          typeof parsed.prompt_eval_count === 'number' ||
          typeof parsed.eval_count === 'number'
        ) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: parsed.prompt_eval_count ?? 0,
              outputTokens: parsed.eval_count ?? 0,
            },
          };
        }
        if (parsed.message?.content) yield { type: 'text', text: parsed.message.content };
        // Ollama emits each tool call complete within a single streamed chunk,
        // so there is nothing to accumulate across fragments.
        for (const call of parsed.message?.tool_calls ?? []) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: randomUUID(),
              name: call.function.name,
              arguments: JSON.stringify(call.function.arguments),
            },
          };
        }
      }
    }
  }

  async logout(): Promise<void> {
    // No-op: Ollama has no auth state to clear.
  }
}
