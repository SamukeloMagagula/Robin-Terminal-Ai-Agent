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

  async *chat(model: string, messages: Message[], _tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
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

  async logout(): Promise<void> {
    // No-op: Ollama has no auth state to clear.
  }
}
