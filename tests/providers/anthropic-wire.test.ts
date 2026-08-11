import { describe, it, expect } from 'vitest';
import { toAnthropicRequest, toAnthropicTools } from '../../src/providers/anthropic-wire';
import type { Message } from '../../src/providers/types';

describe('toAnthropicRequest', () => {
  it('lifts the system message out of the message list', () => {
    const { system, messages } = toAnthropicRequest([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(system).toBe('Be terse.');
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('joins several system messages rather than dropping any', () => {
    const { system } = toAnthropicRequest([
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'hi' },
    ]);

    expect(system).toBe('first\n\nsecond');
  });

  it('omits system entirely when there is none', () => {
    expect(toAnthropicRequest([{ role: 'user', content: 'hi' }]).system).toBeUndefined();
  });

  it('turns a tool message into a tool_result block on a user message', () => {
    const { messages } = toAnthropicRequest([
      { role: 'tool', content: 'exit 0', toolCallId: 'toolu_1' },
    ]);

    expect(messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'exit 0' }],
      },
    ]);
  });

  it('parses assistant tool-call arguments from JSON string back to an object', () => {
    const { messages } = toAnthropicRequest([
      {
        role: 'assistant',
        content: 'running it',
        toolCalls: [{ id: 'toolu_1', name: 'run_command', arguments: '{"command":"ls"}' }],
      },
    ]);

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'running it' },
        { type: 'tool_use', id: 'toolu_1', name: 'run_command', input: { command: 'ls' } },
      ],
    });
  });

  it('falls back to an empty object when tool arguments are not valid JSON', () => {
    const { messages } = toAnthropicRequest([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'run_command', arguments: 'not json' }],
      },
    ]);

    const blocks = messages[0].content as { type: string; input?: unknown }[];
    expect(blocks[0].input).toEqual({});
  });

  it('drops an assistant turn with neither text nor tool calls', () => {
    // The API rejects a message with empty content; an interrupted turn can
    // produce one.
    const { messages } = toAnthropicRequest([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ]);

    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps a full tool round-trip in order', () => {
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'run_command', arguments: '{"command":"ls"}' }],
      },
      { role: 'tool', content: 'a.txt', toolCallId: 'toolu_1' },
      { role: 'assistant', content: 'There is one file.' },
    ];

    const { system, messages } = toAnthropicRequest(history);

    expect(system).toBe('sys');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('toAnthropicTools', () => {
  it('renames parameters to input_schema', () => {
    const tools = toAnthropicTools([
      {
        name: 'run_command',
        description: 'Run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ]);

    expect(tools).toEqual([
      {
        name: 'run_command',
        description: 'Run a command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ]);
  });

  it('returns an empty array for no tools', () => {
    expect(toAnthropicTools()).toEqual([]);
    expect(toAnthropicTools([])).toEqual([]);
  });
});
