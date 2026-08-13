import { describe, it, expect } from 'vitest';
import type { Message } from '../../src/providers/types';
import {
  estimateTokens,
  estimateMessagesTokens,
  budgetFor,
  trimHistory,
} from '../../src/repl/trim-history';

/** A message of roughly `tokens` tokens. */
function sized(role: Message['role'], tokens: number, marker = 'x'): Message {
  return { role, content: marker.repeat(tokens * 4) };
}

describe('estimateTokens', () => {
  it('counts four characters to the token', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('rounds a partial token up', () => {
    expect(estimateTokens('123')).toBe(1);
  });
});

describe('trimHistory', () => {
  it('leaves a history that already fits untouched', () => {
    const messages: Message[] = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hi' },
    ];
    const result = trimHistory(messages, 10_000);
    expect(result.dropped).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('drops the oldest messages and keeps the newest', () => {
    const messages: Message[] = [
      { role: 'system', content: 'rules' },
      sized('user', 100, 'a'),
      sized('assistant', 100, 'b'),
      sized('user', 100, 'c'),
    ];
    const result = trimHistory(messages, 300); // budget 240

    expect(result.dropped).toBeGreaterThan(0);
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(budgetFor(300));
    expect(result.messages[result.messages.length - 1].content.startsWith('c')).toBe(true);
  });

  it('always keeps the system message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'rules that must survive' },
      sized('user', 500, 'a'),
      sized('user', 500, 'b'),
    ];
    const result = trimHistory(messages, 600);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'rules that must survive' });
  });

  it('never separates a tool result from the call it answers', () => {
    const messages: Message[] = [
      { role: 'system', content: 'rules' },
      sized('user', 200, 'old'),
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{"command":"dir"}' }],
      },
      { role: 'tool', content: 'output', toolCallId: 'c1' },
      { role: 'user', content: 'and now?' },
    ];
    const result = trimHistory(messages, 400);

    const hasToolResult = result.messages.some((m) => m.role === 'tool');
    const hasToolCall = result.messages.some((m) => m.toolCalls);
    expect(hasToolResult).toBe(hasToolCall);
  });

  it('truncates rather than dropping when the newest message alone is too big', () => {
    const messages: Message[] = [
      { role: 'system', content: 'rules' },
      sized('user', 5000, 'z'),
    ];
    const result = trimHistory(messages, 1000);

    const user = result.messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    expect(user?.content).toContain('trimmed to fit');
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(budgetFor(1000));
  });
});
