import type Anthropic from '@anthropic-ai/sdk';
import type { Message, ToolDefinition } from './types.js';

/**
 * Anthropic's Messages API differs from the OpenAI shape the other providers
 * share, in three ways that matter here:
 *
 * 1. The system prompt is a top-level request field, not a message with
 *    role "system".
 * 2. Tool results are `tool_result` blocks inside a **user** message, not
 *    messages with role "tool".
 * 3. Tool arguments arrive as a parsed object (`input`), where Robin's ToolCall
 *    carries a JSON-encoded string.
 *
 * None of `openai-compatible.ts` applies, so this module owns the translation.
 */
export interface AnthropicRequestShape {
  system?: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Splits Robin's flat message list into Anthropic's (system, messages) pair.
 *
 * Several system messages are joined rather than dropped: Robin composes the
 * environment preamble, personality and /system prompt into one string today,
 * but a loaded conversation can carry more than one.
 */
export function toAnthropicRequest(messages: Message[]): AnthropicRequestShape {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) systemParts.push(message.content);
      continue;
    }

    if (message.role === 'tool') {
      // A tool result is a user-role content block on Anthropic, not its own
      // role. Consecutive ones are left as separate messages — the API
      // combines same-role neighbours itself.
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? '',
            content: message.content,
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          // Robin stores arguments as a JSON string; Anthropic wants the object.
          input: parseArguments(call.arguments),
        });
      }
      // An assistant turn with neither text nor tool calls is not a valid
      // message — skip it rather than sending empty content.
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: 'user', content: message.content });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

/** Model-generated JSON, so nothing about its shape is guaranteed. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/** Robin's tool shape to Anthropic's — `parameters` is called `input_schema`. */
export function toAnthropicTools(tools?: ToolDefinition[]): Anthropic.Tool[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}
