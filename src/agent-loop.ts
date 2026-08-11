import type { Provider, Message, ToolCall, ToolDefinition } from './providers/types.js';
import type { ConfirmFn } from './tools/execute.js';
import { isAbortError } from './providers/chat-error.js';

export type { ConfirmFn };

export interface AgentDeps {
  confirm: ConfirmFn;
  executeTool: (toolCall: ToolCall, confirm: ConfirmFn) => Promise<string>;
  onText: (text: string) => void;
  /** Cancels the in-flight request. An abort ends the turn, keeping what streamed. */
  signal?: AbortSignal;
}

const MAX_ROUNDS = 10;

export async function runAgentTurn(
  provider: Provider,
  model: string,
  history: Message[],
  tools: ToolDefinition[],
  deps: AgentDeps
): Promise<Message[]> {
  const newMessages: Message[] = [];
  let workingHistory = [...history];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = '';
    const toolCalls: ToolCall[] = [];

    try {
      for await (const event of provider.chat(model, workingHistory, tools, deps.signal)) {
        if (event.type === 'text') {
          text += event.text;
          deps.onText(event.text);
        } else {
          toolCalls.push(event.toolCall);
        }
      }
    } catch (err) {
      // A cancellation is not a failure. Keep what was streamed and return it
      // as a normal result, so the caller's fallback chain never sees it — a
      // user who pressed Esc must not have their prompt immediately re-sent to
      // a different model. Their next message then reads as a redirect rather
      // than a non-sequitur.
      if (!isAbortError(err)) throw err;
      newMessages.push({ role: 'assistant', content: `${text}\n\n[interrupted]` });
      return newMessages;
    }

    const assistantMessage: Message = { role: 'assistant', content: text };
    if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
    newMessages.push(assistantMessage);
    workingHistory = [...workingHistory, assistantMessage];

    if (toolCalls.length === 0) {
      return newMessages;
    }

    for (const toolCall of toolCalls) {
      const result = await deps.executeTool(toolCall, deps.confirm);
      const toolMessage: Message = { role: 'tool', content: result, toolCallId: toolCall.id };
      newMessages.push(toolMessage);
      workingHistory = [...workingHistory, toolMessage];
    }
  }

  const limitMessage: Message = {
    role: 'assistant',
    content: `Stopped after reaching the maximum number of tool-call rounds (${MAX_ROUNDS}).`,
  };
  newMessages.push(limitMessage);
  return newMessages;
}
