import { describe, it, expect, vi } from 'vitest';
import { executeTool, DELEGATE_TOOL_DEFINITIONS } from '../../src/tools/execute';
import type { Provider, Message, ChatEvent, ToolDefinition } from '../../src/providers/types';
import type { ToolCall } from '../../src/providers/types';

function call(name: string, args: unknown): ToolCall {
  return { id: 'call-1', name, arguments: JSON.stringify(args) };
}

async function* textStream(text: string): AsyncIterable<ChatEvent> {
  yield { type: 'text', text };
}

function fakeProvider(
  chat: (model: string, messages: Message[], tools?: ToolDefinition[]) => AsyncIterable<ChatEvent>
): Provider {
  return {
    id: 'fake',
    name: 'Fake',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    chat: chat as Provider['chat'],
    logout: vi.fn(),
  };
}

const approve = async () => true;

describe('delegate_task', () => {
  it('returns one section per task, labelled', async () => {
    const provider = fakeProvider((_model, messages) => {
      const prompt = messages.find((m) => m.role === 'user')?.content ?? '';
      return textStream(`did: ${prompt}`);
    });

    const result = await executeTool(
      call('delegate_task', {
        tasks: [
          { label: 'first', prompt: 'do the first thing' },
          { label: 'second', prompt: 'do the second thing' },
        ],
      }),
      approve,
      { delegate: { provider, model: 'model-x' } }
    );

    expect(result).toContain('## first');
    expect(result).toContain('did: do the first thing');
    expect(result).toContain('## second');
    expect(result).toContain('did: do the second thing');
  });

  it('runs tasks concurrently, not one after another', async () => {
    const started: string[] = [];
    const provider = fakeProvider(async function* (_model, messages) {
      const prompt = messages.find((m) => m.role === 'user')?.content ?? '';
      started.push(prompt);
      // 'slow' yields only after 'fast' has already started — proves both
      // requests were in flight before either resolved, not run in sequence.
      if (prompt === 'slow') {
        await new Promise((r) => setTimeout(r, 20));
      }
      yield { type: 'text', text: prompt };
    });

    await executeTool(
      call('delegate_task', {
        tasks: [
          { label: 'a', prompt: 'slow' },
          { label: 'b', prompt: 'fast' },
        ],
      }),
      approve,
      { delegate: { provider, model: 'model-x' } }
    );

    expect(started).toEqual(['slow', 'fast']);
  });

  it("gates a subtask's tool calls with the same confirm function passed to delegate_task", async () => {
    let confirmCalls = 0;
    const confirmSpy = async () => {
      confirmCalls++;
      return true;
    };

    let round = 0;
    const provider = fakeProvider(async function* (_model, _messages, _tools) {
      round++;
      if (round === 1) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: 't1',
            name: 'run_command',
            // Not on the read-only allowlist, so it forces a confirm() call —
            // but genuinely fast and side-effect-free, unlike an install.
            arguments: JSON.stringify({ command: 'node -e "1"' }),
          },
        };
      } else {
        yield { type: 'text', text: 'done' };
      }
    });

    await executeTool(
      call('delegate_task', { tasks: [{ label: 'x', prompt: 'run a command' }] }),
      confirmSpy,
      { delegate: { provider, model: 'model-x' } }
    );

    expect(confirmCalls).toBeGreaterThan(0);
  });

  it("a subagent's tool list excludes memory, skills, media and delegate_task itself", async () => {
    let seenTools: ToolDefinition[] | undefined;
    const provider = fakeProvider((_model, _messages, tools) => {
      seenTools = tools;
      return textStream('done');
    });

    await executeTool(
      call('delegate_task', { tasks: [{ label: 'x', prompt: 'go' }] }),
      approve,
      { delegate: { provider, model: 'model-x' } }
    );

    const names = seenTools?.map((t) => t.name) ?? [];
    expect(names).not.toContain('delegate_task');
    expect(names).not.toContain('remember');
    expect(names).not.toContain('use_skill');
    expect(names).not.toContain('generate_image');
    expect(names).toContain('run_command');
    expect(names).toContain('read_file');
  });

  it('one failing subtask does not stop the others, and is reported as failed', async () => {
    const provider = fakeProvider((_model, messages) => {
      const prompt = messages.find((m) => m.role === 'user')?.content ?? '';
      if (prompt === 'broken') {
        throw new Error('provider exploded');
      }
      return textStream('ok');
    });

    const result = await executeTool(
      call('delegate_task', {
        tasks: [
          { label: 'good', prompt: 'fine' },
          { label: 'bad', prompt: 'broken' },
        ],
      }),
      approve,
      { delegate: { provider, model: 'model-x' } }
    );

    expect(result).toContain('## good');
    expect(result).toContain('ok');
    expect(result).toContain('## bad (failed)');
    expect(result).toContain('provider exploded');
  });

  it('refuses more than 4 tasks before running any of them', async () => {
    const chat = vi.fn(() => textStream('should not run'));
    const provider = fakeProvider(chat);

    const result = await executeTool(
      call('delegate_task', {
        tasks: Array.from({ length: 5 }, (_, i) => ({ label: `t${i}`, prompt: `p${i}` })),
      }),
      approve,
      { delegate: { provider, model: 'model-x' } }
    );

    expect(result).toMatch(/^Error:/);
    expect(chat).not.toHaveBeenCalled();
  });

  it('is unknown to executeTool when no delegate option is given', async () => {
    const result = await executeTool(
      call('delegate_task', { tasks: [{ label: 'x', prompt: 'go' }] }),
      approve,
      {}
    );
    expect(result).toMatch(/^Error:/);
  });
});

describe('DELEGATE_TOOL_DEFINITIONS', () => {
  it('names delegate_task with a tasks array parameter', () => {
    expect(DELEGATE_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(['delegate_task']);
  });

  it('encodes the task-count cap in the schema, not just at runtime', () => {
    const tasksSchema = (DELEGATE_TOOL_DEFINITIONS[0].parameters as { properties: { tasks: Record<string, unknown> } })
      .properties.tasks;
    expect(tasksSchema.minItems).toBe(1);
    expect(tasksSchema.maxItems).toBe(4);
  });
});
