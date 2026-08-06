import * as readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
import { AuthStore } from '../auth-store.js';
import { announceAndOpen } from '../browser.js';
import { describeChatError } from './http-error.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const API_KEY_PAGE = 'https://aistudio.google.com/apikey';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Translate internal Message[] into Gemini's contents/systemInstruction shape.
 * Gemini has no "system" role in `contents` (it's a separate top-level field)
 * and no tool-call id concept — a tool result is matched back to its call by
 * function *name*, so we track id -> name from the preceding assistant turn.
 */
function toGeminiRequest(messages: Message[]): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  let systemInstruction: { parts: GeminiPart[] } | undefined;
  const contents: GeminiContent[] = [];
  const nameByToolCallId = new Map<string, string>();

  for (const message of messages) {
    if (message.role === 'system') {
      systemInstruction = { parts: [{ text: message.content }] };
    } else if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: message.content }] });
    } else if (message.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        nameByToolCallId.set(call.id, call.name);
        parts.push({ functionCall: { name: call.name, args: parseArguments(call.arguments) } });
      }
      contents.push({ role: 'model', parts });
    } else if (message.role === 'tool') {
      const name = (message.toolCallId && nameByToolCallId.get(message.toolCallId)) || 'unknown_function';
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name, response: { result: message.content } } }],
      });
    }
  }

  return { systemInstruction, contents };
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini';
  readonly name = 'Gemini';

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
      apiKey = (await rl.question('Paste your Gemini API key: ')).trim();
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
    if (!apiKey) throw new Error('Not logged in to Gemini. Run `login gemini` first.');
    return apiKey;
  }

  async listModels(): Promise<string[]> {
    const apiKey = await this.getApiKey();
    const res = await fetch(`${BASE_URL}/models?key=${apiKey}`);
    if (!res.ok) throw new Error(`Failed to list Gemini models: ${res.status}`);
    const data = (await res.json()) as {
      models: { name: string; supportedGenerationMethods?: string[] }[];
    };
    return data.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }

  async *chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    const apiKey = await this.getApiKey();
    const { systemInstruction, contents } = toGeminiRequest(messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (tools && tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const res = await fetch(`${BASE_URL}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      throw new Error(describeChatError('Gemini', res.status));
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
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonText = trimmed.slice('data:'.length).trim();
        if (!jsonText) continue;
        const parsed = JSON.parse(jsonText) as {
          candidates?: { content?: { parts?: GeminiPart[] } }[];
        };
        const parts = parsed.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) yield { type: 'text', text: part.text };
          if (part.functionCall) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: randomUUID(),
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              },
            };
          }
        }
      }
    }
  }
}
