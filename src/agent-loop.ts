import type { Provider, Message, ToolCall, ToolDefinition, TokenUsage } from './providers/types.js';
import type { ConfirmFn } from './tools/execute.js';
import { isAbortError } from './providers/chat-error.js';
import { createAnswerUnwrapper } from './answer-wrapper.js';

export type { ConfirmFn };

export interface AgentDeps {
  confirm: ConfirmFn;
  executeTool: (toolCall: ToolCall, confirm: ConfirmFn) => Promise<string>;
  onText: (text: string) => void;
  /** Reasoning summaries, where the provider streams them. Display only. */
  onThinking?: (text: string) => void;
  /**
   * What one request cost, where the provider says.
   *
   * Called once per round, so a turn that used three tool calls reports three
   * times — each is a separate request with its own bill.
   */
  onUsage?: (usage: TokenUsage) => void;
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
    let roundUsage: TokenUsage | undefined;
    const toolCalls: ToolCall[] = [];
    // Some models wrap every reply in <final_answer>…</final_answer>. Stripped
    // here rather than at render time so the history is clean too — otherwise
    // the markup is replayed to the model on every later turn as if it were
    // something the assistant meant to say.
    const unwrap = createAnswerUnwrapper();

    try {
      for await (const event of provider.chat(model, workingHistory, tools, deps.signal)) {
        if (event.type === 'text') {
          const visible = unwrap.push(event.text);
          if (visible) {
            text += visible;
            deps.onText(visible);
          }
        } else if (event.type === 'usage') {
          // Replaced, not accumulated. Gemini repeats usageMetadata on every
          // frame with the total so far, so adding them up multiplies the
          // count — three reports in one request became triple the tokens.
          // One request is billed once; the last word is the true one.
          roundUsage = event.usage;
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
      // An interrupted request was still served in part, and still billed.
      if (roundUsage) deps.onUsage?.(roundUsage);
      const remainder = unwrap.end();
      if (remainder) {
        text += remainder;
        deps.onText(remainder);
      }
      newMessages.push({ role: 'assistant', content: `${text}\n\n[interrupted]` });
      return newMessages;
    }

    // One report per request, once the request is over.
    if (roundUsage) deps.onUsage?.(roundUsage);

    // Whatever was held back waiting to see if it was part of a closing tag.
    const remainder = unwrap.end();
    if (remainder) {
      text += remainder;
      deps.onText(remainder);
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
        const note = emptyReplyNote(model, round > 0);
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

/**
 * The advice appended to both empty-reply notes.
 *
 * Shared by the note and the check below so the two cannot drift apart: an
 * unattended caller has to be able to tell this apart from a real answer, and
 * matching on prose written somewhere else would break the first time it was
 * reworded.
 */
const EMPTY_REPLY_ADVICE = '— ask again, or /model to switch.]';

/** What stands in for an answer when the model produced none. */
export function emptyReplyNote(model: string, ranTools: boolean): string {
  const what = ranTools ? 'ran its tools but produced no answer' : 'returned an empty reply';
  return `[${model} ${what} ${EMPTY_REPLY_ADVICE}`;
}

/**
 * Whether a reply is really a note saying there was no reply.
 *
 * A person reading it in a terminal understands immediately. Something acting
 * on the answer — a scheduled job about to send it somewhere — has to be able
 * to tell, so that "the model said nothing" is not delivered as a report.
 */
export function isEmptyReplyNote(text: string): boolean {
  return text.trimEnd().endsWith(EMPTY_REPLY_ADVICE);
}
