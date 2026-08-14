import { describe, it, expect } from 'vitest';
import { streamOpenAiCompatibleChat } from '../../src/providers/openai-compatible';
import type { ChatEvent } from '../../src/providers/types';

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, body, status: 200 } as unknown as Response;
}

async function drain(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const seen: ChatEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('streamOpenAiCompatibleChat and usage', () => {
  it('reports the usage frame the provider sends', async () => {
    const events = await drain(
      streamOpenAiCompatibleChat(
        sse([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8}}\n',
          'data: [DONE]\n',
        ]),
        'Test'
      )
    );

    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 120, outputTokens: 8 },
    });
  });

  it('still yields the text alongside it', async () => {
    const events = await drain(
      streamOpenAiCompatibleChat(
        sse([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
          'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n',
          'data: [DONE]\n',
        ]),
        'Test'
      )
    );

    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  // Absent usage must not become a count of zero: "we do not know" and "it cost
  // nothing" are different answers, and only one of them is ever true.
  it('says nothing when the provider reports no usage', async () => {
    const events = await drain(
      streamOpenAiCompatibleChat(
        sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: [DONE]\n']),
        'Test'
      )
    );

    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('ignores a usage frame with nothing usable in it', async () => {
    const events = await drain(
      streamOpenAiCompatibleChat(
        sse(['data: {"usage":{"prompt_tokens":null}}\n', 'data: [DONE]\n']),
        'Test'
      )
    );

    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('treats a missing half as zero, since the other half is still worth having', async () => {
    const events = await drain(
      streamOpenAiCompatibleChat(
        sse(['data: {"usage":{"prompt_tokens":50}}\n', 'data: [DONE]\n']),
        'Test'
      )
    );

    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 50, outputTokens: 0 },
    });
  });
});
