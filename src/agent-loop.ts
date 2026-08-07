import type { Provider, Message, ToolCall, ToolDefinition } from './providers/types.js';
import type { ConfirmFn } from './tools/execute.js';

export type { ConfirmFn };

export interface AgentDeps {
  confirm: ConfirmFn;
  executeTool: (toolCall: ToolCall, confirm: ConfirmFn) => Promise<string>;
  onText: (text: string) => void;
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

    for await (const event of provider.chat(model, workingHistory, tools)) {
      if (event.type === 'text') {
        text += event.text;
        deps.onText(event.text);
      } else {
        toolCalls.push(event.toolCall);
      }
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
