import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';

const BASE_URL = 'http://localhost:11434';

interface TagsResponse {
  models: { name: string }[];
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

  async *chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    if (tools && tools.length > 0) {
      yield* this.chatWithTools(model, messages, tools);
      return;
    }
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat request failed: ${res.status}`);
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
        const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) yield { type: 'text', text: parsed.message.content };
      }
    }
  }

  private async *chatWithTools(
    model: string,
    messages: Message[],
    tools: ToolDefinition[]
  ): AsyncIterable<ChatEvent> {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    });
    if (!res.ok) throw new Error(`Ollama chat request failed: ${res.status}`);
    const data = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
      };
    };
    if (data.message?.content) yield { type: 'text', text: data.message.content };
    const toolCalls = data.message?.tool_calls ?? [];
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      yield {
        type: 'tool_call',
        toolCall: {
          id: `ollama-call-${i}`,
          name: call.function.name,
          arguments: JSON.stringify(call.function.arguments),
        },
      };
    }
  }

  async logout(): Promise<void> {
    // No-op: Ollama has no auth state to clear.
  }
}
