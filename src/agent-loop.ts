import type { Provider, Message, ToolCall, ToolDefinition } from './providers/types.js';
import type { ConfirmFn } from './tools/execute.js';
import { isAbortError } from './providers/chat-error.js';

export type { ConfirmFn };

export interface AgentDeps {
  confirm: ConfirmFn;
  executeTool: (toolCall: ToolCall, confirm: ConfirmFn) => Promise<string>;
  onText: (text: string) => void;
  /** Reasoning summaries, where the provider streams them. Display only. */
  onThinking?: (text: string) => void;
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
        } else if (event.type === 'thinking') {
          // Deliberately not accumulated into `text`: reasoning is shown to
          // the user but must not become part of the assistant's message, or
          // it would be replayed as content on every later turn.
          deps.onThinking?.(event.text);
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
      // A round can end with neither text nor tool calls: the model emitted
      // only reasoning, or only a wrapper tag whose body was empty. Returning
      // as-is leaves the user staring at a bare prompt with no way to tell a
      // silent answer from a crash, so say which of the two it was.
      if (text.trim() === '') {
        const note =
          round === 0
            ? `[${model} returned an empty reply — ask again, or /model to switch.]`
            : `[${model} ran its tools but produced no answer — ask again, or /model to switch.]`;
        assistantMessage.content = note;
        deps.onText(note);
      }
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
