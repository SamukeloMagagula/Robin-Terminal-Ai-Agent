import type { Provider, Message, ChatEvent, ToolCall, ToolDefinition } from './types.js';
import { AuthStore } from '../auth-store.js';

const CLIENT_ID = '01ab8ac9400c4e429b23';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CopilotProvider implements Provider {
  readonly id = 'copilot';
  readonly name = 'GitHub Copilot';

  private copilotToken: string | undefined;
  private copilotTokenExpiresAt = 0;

  constructor(private readonly authStore: AuthStore = new AuthStore()) {}

  async isAuthenticated(): Promise<boolean> {
    const stored = await this.authStore.get(this.id);
    return typeof stored?.githubToken === 'string';
  }

  async login(): Promise<void> {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
    });
    if (!res.ok) throw new Error(`Failed to start device login: ${res.status}`);
    const data = (await res.json()) as DeviceCodeResponse;

    console.log(`Go to ${data.verification_uri} and enter code: ${data.user_code}`);

    const githubToken = await this.pollForToken(data.device_code, data.interval);
    await this.authStore.set(this.id, { githubToken });
  }

  private async pollForToken(deviceCode: string, intervalSeconds: number): Promise<string> {
    let interval = intervalSeconds;
    while (true) {
      await sleep(interval * 1000);
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data = (await res.json()) as AccessTokenResponse;
      if (data.access_token) return data.access_token;
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        interval += 5;
        continue;
      }
      throw new Error(`GitHub device login failed: ${data.error ?? 'unknown error'}`);
    }
  }

  private async getCopilotToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.copilotToken && now < this.copilotTokenExpiresAt - 60) {
      return this.copilotToken;
    }
    const stored = await this.authStore.get(this.id);
    const githubToken = stored?.githubToken as string | undefined;
    if (!githubToken) throw new Error('Not logged in to Copilot. Run `login copilot` first.');

    const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: { authorization: `token ${githubToken}` },
    });
    if (!res.ok) throw new Error(`Failed to refresh Copilot token: ${res.status}`);
    const data = (await res.json()) as CopilotTokenResponse;
    this.copilotToken = data.token;
    this.copilotTokenExpiresAt = data.expires_at;
    return this.copilotToken;
  }

  async listModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini'];
  }

  async *chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    const token = await this.getCopilotToken();
    const res = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
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
      throw new Error(`Copilot chat request failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallsByIndex = new Map<number, ToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          yield* emitToolCalls(toolCallsByIndex);
          return;
        }
        const parsed = JSON.parse(payload) as {
          choices?: {
            delta?: {
              content?: string;
              tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) yield { type: 'text', text: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const existing = toolCallsByIndex.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
        }
      }
    }
    yield* emitToolCalls(toolCallsByIndex);
  }

  async logout(): Promise<void> {
    await this.authStore.delete(this.id);
    this.copilotToken = undefined;
    this.copilotTokenExpiresAt = 0;
  }
}

function* emitToolCalls(toolCallsByIndex: Map<number, ToolCall>): Generator<ChatEvent> {
  const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    yield { type: 'tool_call', toolCall: toolCallsByIndex.get(index)! };
  }
}
