import * as readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
import { AuthStore } from '../auth-store.js';
import { announceAndOpen } from '../browser.js';
import { describeChatError, extractErrorCode, extractServerMessage } from './http-error.js';
import { ChatRequestError } from './chat-error.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const API_KEY_PAGE = 'https://aistudio.google.com/apikey';

interface GeminiPart {
  text?: string;
  /**
   * Set on reasoning parts. Gemini and Gemma thinking models return the
   * model's private reasoning in the same `parts` array as the answer, marked
   * with this flag — without checking it, the reasoning gets printed to the
   * user as though it were the reply.
   */
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

/** True for parts that carry the answer, as opposed to the model's private reasoning. */
export function isAnswerPart(part: { text?: string; thought?: boolean }): boolean {
  return typeof part.text === 'string' && part.text.length > 0 && part.thought !== true;
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

/**
 * Gemini accepts the key either as a `?key=` query parameter or as this
 * header. Query strings get written to proxy logs, server access logs and
 * shell history in a way headers do not, so the header is the only form used.
 */
function apiKeyHeader(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey };
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
    const res = await fetch(`${BASE_URL}/models`, { headers: apiKeyHeader(apiKey) });
    if (!res.ok) throw new Error(`Failed to list Gemini models: ${res.status}`);
    const data = (await res.json()) as {
      models: { name: string; supportedGenerationMethods?: string[] }[];
    };
    return data.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }

  async *chat(
    model: string,
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent> {
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

    const url = `${BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...apiKeyHeader(apiKey) },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => undefined);
      throw new ChatRequestError(describeChatError('Gemini', res.status, body), {
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
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonText = trimmed.slice('data:'.length).trim();
        if (!jsonText) continue;
        // One malformed frame must not abort the turn and discard the text
        // already streamed — skip it and keep reading.
        let parsed: {
          candidates?: { content?: { parts?: GeminiPart[] } }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          continue;
        }

        // Gemini repeats usageMetadata on every frame with a running total, so
        // the last one seen is the one that counts. Yielding each is harmless:
        // the caller keeps the latest rather than summing.
        const usage = parsed.usageMetadata;
        if (usage && (usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined)) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usage.promptTokenCount ?? 0,
              outputTokens: usage.candidatesTokenCount ?? 0,
            },
          };
        }

        const parts = parsed.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (isAnswerPart(part)) yield { type: 'text', text: part.text as string };
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
