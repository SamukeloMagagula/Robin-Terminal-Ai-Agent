import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTurn } from '../../src/repl/run-turn';
import { createSession } from '../../src/repl/session';
import type { Provider } from '../../src/providers/types';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';

// Note: UnsupportedModelStore's constructor takes a *file* path, not a
// directory (see src/providers/unsupported-models.ts). Pointing it at a
// throwaway file keeps these tests off the real ~/.robin/unsupported.json.
function throwawayStore(): UnsupportedModelStore {
  return new UnsupportedModelStore(
    path.join(os.tmpdir(), `robin-unsupported-${Date.now()}-${Math.random()}.json`)
  );
}

/** A provider whose chat() yields the given text, or throws the given error. */
function fakeProvider(
  id: string,
  name: string,
  behaviour: { text?: string; error?: Error; models?: string[] }
): Provider {
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(behaviour.models ?? []),
    chat: vi.fn().mockImplementation(async function* () {
      if (behaviour.error) throw behaviour.error;
      yield { type: 'text', text: behaviour.text ?? 'ok' };
    }),
  } as unknown as Provider;
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    onText: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    unsupportedStore: throwawayStore(),
    providers: [],
    ...overrides,
  } as never;
}

describe('runTurn', () => {
  it('appends the user message and the reply to the session history', async () => {
    const provider = fakeProvider('copilot', 'GitHub Copilot', { text: 'hello there' });
    const session = createSession(provider, 'gpt-4o');

    const result = await runTurn(session, 'hi', options());

    expect(result.ok).toBe(true);
    expect(session.history[0]).toEqual({ role: 'user', content: 'hi' });
    expect(session.history[1].role).toBe('assistant');
    expect(session.history[1].content).toBe('hello there');
  });

  it('streams text through onText rather than stdout', async () => {
    const provider = fakeProvider('copilot', 'GitHub Copilot', { text: 'streamed' });
    const session = createSession(provider, 'gpt-4o');
    const onText = vi.fn();

    await runTurn(session, 'hi', options({ onText }));

    expect(onText).toHaveBeenCalledWith('streamed');
  });

  it('rolls the user message back out of history when the turn fails outright', async () => {
    const provider = fakeProvider('copilot', 'GitHub Copilot', { error: new Error('boom') });
    const session = createSession(provider, 'gpt-4o');

    const result = await runTurn(session, 'hi', options());

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('boom');
    expect(session.history).toEqual([]);
  });

  it('falls back to another provider and reports which one answered', async () => {
    const failing = fakeProvider('copilot', 'GitHub Copilot', { error: new Error('boom') });
    const working = fakeProvider('ollama', 'Ollama (local)', {
      text: 'rescued',
      models: ['llama3.1:latest'],
    });
    const session = createSession(failing, 'gpt-4o');
    const onFallback = vi.fn();

    const result = await runTurn(
      session,
      'hi',
      options({ providers: [failing, working], onFallback })
    );

    expect(result.ok).toBe(true);
    expect(result.provider.id).toBe('ollama');
    expect(result.model).toBe('llama3.1:latest');
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when fallback is disabled', async () => {
    const failing = fakeProvider('copilot', 'GitHub Copilot', { error: new Error('boom') });
    const working = fakeProvider('ollama', 'Ollama (local)', {
      text: 'rescued',
      models: ['llama3.1:latest'],
    });
    const session = createSession(failing, 'gpt-4o');

    const result = await runTurn(
      session,
      'hi',
      options({ providers: [failing, working], fallback: false })
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('boom');
  });

  it('reports an aborted turn without falling back to another model', async () => {
    const controller = new AbortController();
    const failing = {
      id: 'copilot',
      name: 'GitHub Copilot',
      isAuthenticated: vi.fn().mockResolvedValue(true),
      login: vi.fn(),
      logout: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      chat: vi.fn().mockImplementation(async function* () {
        yield { type: 'text', text: 'half an ans' };
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    } as unknown as Provider;
    const rescue = fakeProvider('ollama', 'Ollama (local)', {
      text: 'should never run',
      models: ['llama3.1:latest'],
    });
    const session = createSession(failing, 'gpt-4o');

    const result = await runTurn(
      session,
      'hi',
      options({ providers: [failing, rescue], signal: controller.signal })
    );

    expect(result.aborted).toBe(true);
    expect(rescue.chat).not.toHaveBeenCalled();
    expect(session.history[1].content).toContain('half an ans');
  });

  it('sends no tools when tools are disabled for the turn', async () => {
    const provider = fakeProvider('copilot', 'GitHub Copilot', { text: 'ok' });
    const session = createSession(provider, 'gpt-4o');

    await runTurn(session, 'hi', options({ tools: false }));

    // Assert on the tools argument by position rather than matching the whole
    // call, so adding a parameter to chat() does not break an assertion that
    // is really only about tools.
    const call = (provider.chat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe('gpt-4o');
    expect(call[2]).toEqual([]);
  });
});
