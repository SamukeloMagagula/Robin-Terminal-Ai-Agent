import { describe, it, expect, vi } from 'vitest';
import type { Provider, ChatEvent, ToolCall } from '../src/providers/types';
import { runAgentTurn } from '../src/agent-loop';

function fakeProvider(responses: ChatEvent[][]): Provider {
  let call = 0;
  const chat = async function* (): AsyncIterable<ChatEvent> {
    const events = responses[call] ?? [];
    call += 1;
    for (const event of events) yield event;
  };
  return {
    id: 'fake',
    name: 'Fake',
    isAuthenticated: vi.fn(),
    login: vi.fn(),
    listModels: vi.fn(),
    logout: vi.fn(),
    chat,
  } as unknown as Provider;
}

describe('runAgentTurn', () => {
  it('returns a single assistant message when there are no tool calls', async () => {
    const provider = fakeProvider([[{ type: 'text', text: 'Hello there' }]]);
    const onText = vi.fn();
    const result = await runAgentTurn(provider, 'model', [], [], {
      confirm: async () => true,
      executeTool: vi.fn(),
      onText,
    });
    expect(result).toEqual([{ role: 'assistant', content: 'Hello there' }]);
    expect(onText).toHaveBeenCalledWith('Hello there');
  });

  it('executes a tool call, feeds the result back, and returns the final text', async () => {
    const toolCall: ToolCall = { id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' };
    const provider = fakeProvider([
      [{ type: 'tool_call', toolCall }],
      [{ type: 'text', text: 'The file says hi.' }],
    ]);
    const executeTool = vi.fn().mockResolvedValue('hi');
    const result = await runAgentTurn(provider, 'model', [], [], {
      confirm: async () => true,
      executeTool,
      onText: vi.fn(),
    });
    expect(executeTool).toHaveBeenCalledWith(toolCall, expect.any(Function));
    expect(result).toEqual([
      { role: 'assistant', content: '', toolCalls: [toolCall] },
      { role: 'tool', content: 'hi', toolCallId: 'call-1' },
      { role: 'assistant', content: 'The file says hi.' },
    ]);
  });

  it('stops after the maximum number of rounds', async () => {
    const toolCall: ToolCall = { id: 'call-1', name: 'run_command', arguments: '{"command":"x"}' };
    const responses: ChatEvent[][] = Array.from({ length: 15 }, () => [{ type: 'tool_call', toolCall }]);
    const provider = fakeProvider(responses);
    const result = await runAgentTurn(provider, 'model', [], [], {
      confirm: async () => true,
      executeTool: vi.fn().mockResolvedValue('ok'),
      onText: vi.fn(),
    });
    const last = result[result.length - 1];
    expect(last.content).toMatch(/maximum number of tool-call rounds/);
  });
});
