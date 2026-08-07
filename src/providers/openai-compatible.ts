import type { Message, ChatEvent, ToolCall, ToolDefinition } from './types.js';
import { describeChatError, extractErrorCode } from './http-error.js';
import { ChatRequestError } from './chat-error.js';

export interface OpenAiWireMessage {
  role: Message['role'];
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Translate an internal camelCase `Message` into the OpenAI-compatible chat/completions wire shape. */
export function toOpenAiWireMessage(message: Message): OpenAiWireMessage {
  const wire: OpenAiWireMessage = { role: message.role, content: message.content };
  if (message.toolCalls && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  if (message.toolCallId) wire.tool_call_id = message.toolCallId;
  return wire;
}

export function toOpenAiToolsPayload(tools?: ToolDefinition[]): Record<string, unknown> {
  if (!tools || tools.length === 0) return {};
  return {
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  };
}

/** Parses an OpenAI-compatible chat/completions SSE stream (`data: {...}` lines, terminated by `data: [DONE]`). */
export async function* streamOpenAiCompatibleChat(response: Response, errorLabel: string): AsyncIterable<ChatEvent> {
  if (!response.ok || !response.body) {
    // Read the body before throwing: the provider's own message ("The
    // requested model is not supported") is the only thing that distinguishes
    // one 400 from another, and it used to be discarded.
    const body = await response.text().catch(() => undefined);
    throw new ChatRequestError(describeChatError(errorLabel, response.status, body), {
      status: response.status,
      code: extractErrorCode(body),
    });
  }
  const reader = response.body.getReader();
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
      if (!payload) continue;
      // A single malformed SSE frame must not abort the whole turn and throw
      // away the text already streamed — skip it and keep reading.
      let parsed: {
        choices?: {
          delta?: {
            content?: string;
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
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

function* emitToolCalls(toolCallsByIndex: Map<number, ToolCall>): Generator<ChatEvent> {
  const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    yield { type: 'tool_call', toolCall: toolCallsByIndex.get(index)! };
  }
}
