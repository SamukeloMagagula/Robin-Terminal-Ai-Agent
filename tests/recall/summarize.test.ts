import { describe, it, expect, vi } from 'vitest';
import { summarizeMatches, SUMMARIZE_THRESHOLD } from '../../src/recall/summarize';
import type { Provider, Message, ChatEvent } from '../../src/providers/types';
import type { RecallMatch } from '../../src/recall';

function fakeProvider(chat: Provider['chat']): Provider {
  return {
    id: 'fake',
    name: 'Fake',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    chat,
    logout: vi.fn(),
  };
}

async function* textStream(...chunks: string[]): AsyncIterable<ChatEvent> {
  for (const chunk of chunks) yield { type: 'text', text: chunk };
}

const matches: RecallMatch[] = [
  { file: '2026-01-01.md', lineNumber: 12, context: ['decided to use SQLite for the index'] },
  { file: '2026-01-03.md', lineNumber: 40, context: ['switched the poll interval to 2s'] },
];

describe('summarizeMatches', () => {
  it('returns the collected text from the provider', async () => {
    const provider = fakeProvider(() => textStream('We discussed ', 'the recall index.'));
    const summary = await summarizeMatches(provider, 'model-x', 'recall index', matches);
    expect(summary).toBe('We discussed the recall index.');
  });

  it('calls chat with no tools and no history beyond the one request', async () => {
    let seenMessages: Message[] = [];
    let seenTools: unknown;
    const chat = vi.fn((_model: string, messages: Message[], tools?: unknown) => {
      seenMessages = messages;
      seenTools = tools;
      return textStream('summary');
    });
    const provider = fakeProvider(chat as Provider['chat']);

    await summarizeMatches(provider, 'model-x', 'recall index', matches);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(seenTools).toEqual([]);
    expect(seenMessages.some((m) => m.role === 'system')).toBe(true);
  });

  it('includes every match, formatted with its file and line, in the request', async () => {
    let seenMessages: Message[] = [];
    const chat = vi.fn((_model: string, messages: Message[]) => {
      seenMessages = messages;
      return textStream('summary');
    });
    const provider = fakeProvider(chat as Provider['chat']);

    await summarizeMatches(provider, 'model-x', 'recall index', matches);

    const userContent = seenMessages.find((m) => m.role === 'user')?.content ?? '';
    expect(userContent).toContain('2026-01-01.md:12');
    expect(userContent).toContain('decided to use SQLite for the index');
    expect(userContent).toContain('2026-01-03.md:40');
    expect(userContent).toContain('switched the poll interval to 2s');
  });

  it('includes the search query in the request, so the summary stays on-topic', async () => {
    let seenMessages: Message[] = [];
    const chat = vi.fn((_model: string, messages: Message[]) => {
      seenMessages = messages;
      return textStream('summary');
    });
    const provider = fakeProvider(chat as Provider['chat']);

    await summarizeMatches(provider, 'model-x', 'recall index', matches);

    const userContent = seenMessages.find((m) => m.role === 'user')?.content ?? '';
    expect(userContent).toContain('recall index');
  });

  it('instructs the model not to follow instructions embedded in the excerpts', async () => {
    let seenMessages: Message[] = [];
    const chat = vi.fn((_model: string, messages: Message[]) => {
      seenMessages = messages;
      return textStream('summary');
    });
    const provider = fakeProvider(chat as Provider['chat']);

    await summarizeMatches(provider, 'model-x', 'recall index', matches);

    const systemContent = seenMessages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemContent).toMatch(/not instructions|do not follow|do not treat/i);
  });
});

describe('summarizeMatches — timeout', () => {
  it('rejects rather than hanging forever when the provider never resolves', async () => {
    const chat = vi.fn(
      () =>
        ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => {}), // never resolves
          }),
        }) as AsyncIterable<ChatEvent>
    );
    const provider = fakeProvider(chat as Provider['chat']);

    await expect(
      summarizeMatches(provider, 'model-x', 'recall index', matches, { timeoutMs: 20 })
    ).rejects.toThrow(/timed out/i);
  });

  it('passes an abort signal through to provider.chat so a timeout can actually cancel the request', async () => {
    let seenSignal: AbortSignal | undefined;
    const chat = vi.fn((_model: string, _messages: Message[], _tools?: unknown, signal?: AbortSignal) => {
      seenSignal = signal;
      return textStream('summary');
    });
    const provider = fakeProvider(chat as Provider['chat']);

    await summarizeMatches(provider, 'model-x', 'recall index', matches, { timeoutMs: 5000 });

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('SUMMARIZE_THRESHOLD', () => {
  it('is a small positive number of matches', () => {
    expect(SUMMARIZE_THRESHOLD).toBeGreaterThan(0);
    expect(SUMMARIZE_THRESHOLD).toBeLessThan(10);
  });
});
