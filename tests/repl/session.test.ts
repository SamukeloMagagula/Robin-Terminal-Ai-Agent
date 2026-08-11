import { describe, it, expect, vi } from 'vitest';
import { createSession, buildSystemPrompt } from '../../src/repl/session';
import type { Provider } from '../../src/providers/types';

function fakeProvider(id = 'copilot', name = 'GitHub Copilot'): Provider {
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    chat: vi.fn(),
    logout: vi.fn(),
  } as unknown as Provider;
}

describe('createSession', () => {
  it('starts with an empty history, tools on, and no system prompt', () => {
    const session = createSession(fakeProvider(), 'gpt-4o');

    expect(session.id).toBe(1);
    expect(session.model).toBe('gpt-4o');
    expect(session.history).toEqual([]);
    expect(session.toolsEnabled).toBe(true);
    expect(session.systemPrompt).toBeUndefined();
  });

  it('gives each session its own history array', () => {
    const a = createSession(fakeProvider(), 'gpt-4o', 1);
    const b = createSession(fakeProvider(), 'gpt-4o', 2);

    a.history.push({ role: 'user', content: 'hello' });

    expect(b.history).toEqual([]);
  });
});

describe('buildSystemPrompt', () => {
  it('returns the environment preamble alone when no system prompt is set', () => {
    const session = createSession(fakeProvider(), 'gpt-4o');

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('Working directory:');
    expect(prompt).toContain('run_command tool executes via');
  });

  it('puts the environment preamble before the user system prompt', () => {
    const session = createSession(fakeProvider(), 'gpt-4o');
    session.systemPrompt = 'Answer only in haiku.';

    const prompt = buildSystemPrompt(session);

    expect(prompt.indexOf('Working directory:')).toBeLessThan(
      prompt.indexOf('Answer only in haiku.')
    );
  });
});
