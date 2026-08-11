export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded arguments string
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema for the tool's arguments
}

export type ChatEvent =
  | { type: 'text'; text: string }
  /**
   * A summary of the model's reasoning, where the provider streams one.
   * Shown to the user but never added to the conversation history — the raw
   * chain of thought is not part of the assistant's reply.
   */
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall };

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface Provider {
  id: string;
  name: string;
  isAuthenticated(): Promise<boolean>;
  login(): Promise<void>;
  listModels(): Promise<string[]>;
  chat(
    model: string,
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent>;
  logout(): Promise<void>;
}
