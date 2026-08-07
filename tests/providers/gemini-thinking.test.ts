import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GeminiProvider, isAnswerPart } from '../../src/providers/gemini';
import { AuthStore } from '../../src/auth-store';
import type { ChatEvent } from '../../src/providers/types';

describe('isAnswerPart', () => {
  it('accepts an ordinary text part', () => {
    expect(isAnswerPart({ text: 'Hello!' })).toBe(true);
  });

  // The bug: thinking models return reasoning in the same parts array, and it
  // was being printed to the user as though it were the reply.
  it('rejects a part flagged as the model’s private reasoning', () => {
    expect(isAnswerPart({ text: 'The user said "hey". This is a simple…', thought: true })).toBe(
      false
    );
  });

  it('accepts a part that explicitly marks itself as not reasoning', () => {
    expect(isAnswerPart({ text: 'Hello!', thought: false })).toBe(true);
  });

  it('rejects empty and missing text', () => {
    expect(isAnswerPart({ text: '' })).toBe(false);
    expect(isAnswerPart({})).toBe(false);
  });
});

/** Builds a fetch Response whose body streams the given SSE lines. */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function frame(parts: unknown[]): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}`;
}

describe('GeminiProvider.chat streaming', () => {
  let provider: GeminiProvider;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-think-'));
    const authStore = new AuthStore(path.join(dir, 'auth.json'));
    await authStore.set('gemini', { apiKey: 'test-key' });
    provider = new GeminiProvider(authStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function collect(lines: string[]): Promise<string> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(lines));
    let text = '';
    for await (const event of provider.chat('gemini-2.5-flash', [
      { role: 'user', content: 'hey' },
    ]) as AsyncIterable<ChatEvent>) {
      if (event.type === 'text') text += event.text;
    }
    return text;
  }

  it('streams only the answer, not the reasoning', async () => {
    const text = await collect([
      frame([{ text: 'The user said "hey". I should greet them.', thought: true }]),
      frame([{ text: 'Hello!' }]),
      frame([{ text: ' How can I help you today?' }]),
    ]);
    expect(text).toBe('Hello! How can I help you today?');
    expect(text).not.toContain('The user said');
  });

  it('handles reasoning and answer arriving in one frame', async () => {
    const text = await collect([
      frame([{ text: 'thinking out loud', thought: true }, { text: 'Answer.' }]),
    ]);
    expect(text).toBe('Answer.');
  });

  it('skips a malformed frame instead of losing the whole turn', async () => {
    const text = await collect([
      frame([{ text: 'before ' }]),
      'data: {not valid json',
      frame([{ text: 'after' }]),
    ]);
    expect(text).toBe('before after');
  });
});
