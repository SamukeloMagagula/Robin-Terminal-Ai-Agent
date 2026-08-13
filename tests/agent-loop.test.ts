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

describe('runAgentTurn when aborted mid-stream', () => {
  it('keeps the text streamed so far and marks it interrupted', async () => {
    const controller = new AbortController();
    const provider = {
      chat: async function* () {
        yield { type: 'text', text: 'partial ' };
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    } as unknown as Provider;

    const messages = await runAgentTurn(provider, 'm', [], [], {
      onText: () => {},
      executeTool: async () => '',
      confirm: async () => false,
      signal: controller.signal,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('partial ');
    expect(messages[0].content).toContain('[interrupted]');
  });

  it('says so when the model replies with nothing at all', async () => {
    const provider = fakeProvider([[]]);
    const onText = vi.fn();

    const messages = await runAgentTurn(provider, 'gpt-5.6-terra', [], [], {
      confirm: async () => true,
      executeTool: vi.fn(),
      onText,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('gpt-5.6-terra');
    expect(messages[0].content).toContain('empty reply');
    expect(onText).toHaveBeenCalledWith(expect.stringContaining('empty reply'));
  });

  it('says so when a reply is only reasoning', async () => {
    const provider = fakeProvider([[{ type: 'thinking', text: 'hmm...' }]]);
    const onText = vi.fn();

    await runAgentTurn(provider, 'm', [], [], {
      confirm: async () => true,
      executeTool: vi.fn(),
      onText,
      onThinking: vi.fn(),
    });

    expect(onText).toHaveBeenCalledWith(expect.stringContaining('empty reply'));
  });

  it('says so when tools ran but no answer followed', async () => {
    const toolCall: ToolCall = { id: 'c1', name: 'run_command', arguments: '{"command":"dir"}' };
    const provider = fakeProvider([[{ type: 'tool_call', toolCall }], []]);
    const onText = vi.fn();

    const messages = await runAgentTurn(provider, 'm', [], [], {
      confirm: async () => true,
      executeTool: vi.fn().mockResolvedValue('files'),
      onText,
    });

    expect(messages[messages.length - 1].content).toContain('produced no answer');
  });

  it('leaves a normal reply alone', async () => {
    const provider = fakeProvider([[{ type: 'text', text: 'a real answer' }]]);
    const messages = await runAgentTurn(provider, 'm', [], [], {
      confirm: async () => true,
      executeTool: vi.fn(),
      onText: vi.fn(),
    });
    expect(messages[0].content).toBe('a real answer');
  });

  it('still throws a genuine failure rather than swallowing it', async () => {
    const provider = {
      chat: async function* () {
        yield { type: 'text', text: 'x' };
        throw new Error('503 Service Unavailable');
      },
    } as unknown as Provider;

    await expect(
      runAgentTurn(provider, 'm', [], [], {
        onText: () => {},
        executeTool: async () => '',
        confirm: async () => false,
      })
    ).rejects.toThrow('503');
  });
});
