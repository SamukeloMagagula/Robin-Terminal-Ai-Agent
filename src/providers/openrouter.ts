import * as readline from 'node:readline/promises';
import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
import { AuthStore } from '../auth-store.js';
import { announceAndOpen } from '../browser.js';
import { toOpenAiWireMessage, toOpenAiToolsPayload, streamOpenAiCompatibleChat } from './openai-compatible.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const API_KEY_PAGE = 'https://openrouter.ai/keys';

export class OpenRouterProvider implements Provider {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter';

  constructor(private readonly authStore: AuthStore = new AuthStore()) {}

  async isAuthenticated(): Promise<boolean> {
    const stored = await this.authStore.get(this.id);
    return typeof stored?.apiKey === 'string';
  }

  async login(): Promise<void> {
    announceAndOpen(API_KEY_PAGE);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let apiKey: string;
    try {
      apiKey = (await rl.question('Paste your OpenRouter API key: ')).trim();
    } finally {
      rl.close();
    }
    if (!apiKey) throw new Error('No API key entered.');
    await this.authStore.set(this.id, { apiKey });
  }

  async logout(): Promise<void> {
    await this.authStore.delete(this.id);
  }

  private async getApiKey(): Promise<string> {
    const stored = await this.authStore.get(this.id);
    const apiKey = stored?.apiKey as string | undefined;
    if (!apiKey) throw new Error('Not logged in to OpenRouter. Run `login openrouter` first.');
    return apiKey;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/models`);
    if (!res.ok) throw new Error(`Failed to list OpenRouter models: ${res.status}`);
    const data = (await res.json()) as { data: { id: string }[] };
    return data.data.map((m) => m.id);
  }

  async *chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    const apiKey = await this.getApiKey();
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/robin-cli/robin',
        'X-Title': 'Robin',
      },
      body: JSON.stringify({
        model,
        messages: messages.map(toOpenAiWireMessage),
        stream: true,
        ...toOpenAiToolsPayload(tools),
      }),
    });
    yield* streamOpenAiCompatibleChat(res, 'OpenRouter');
  }
}
