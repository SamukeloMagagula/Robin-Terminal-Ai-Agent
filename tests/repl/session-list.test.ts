import { describe, it, expect, vi } from 'vitest';
import { SessionList, MAX_SESSIONS } from '../../src/repl/session-list';
import type { Provider } from '../../src/providers/types';

function provider(id = 'copilot', name = 'GitHub Copilot'): Provider {
  return { id, name, chat: vi.fn() } as unknown as Provider;
}

function list(): SessionList {
  return new SessionList(provider(), 'gpt-4o');
}

describe('SessionList', () => {
  it('starts with one active session, numbered 1', () => {
    const sessions = list();
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.active.id).toBe(1);
  });

  it('creates a new session and switches to it', () => {
    const sessions = list();

    const created = sessions.create(provider('ollama', 'Ollama'), 'llama3.1');

    expect(created.id).toBe(2);
    expect(sessions.active.id).toBe(2);
    expect(sessions.list()).toHaveLength(2);
  });

  it('switches between sessions by id', () => {
    const sessions = list();
    sessions.create(provider(), 'gpt-4o');

    expect(sessions.switchTo(1).id).toBe(1);
    expect(sessions.active.id).toBe(1);
  });

  it('refuses to switch to an id that does not exist', () => {
    const sessions = list();
    expect(() => sessions.switchTo(7)).toThrow(/No session 7/);
    expect(sessions.active.id).toBe(1);
  });

  it('keeps each session\'s history separate', () => {
    const sessions = list();
    sessions.active.history.push({ role: 'user', content: 'in one' });
    sessions.create(provider(), 'gpt-4o');

    expect(sessions.active.history).toEqual([]);
    expect(sessions.switchTo(1).history).toHaveLength(1);
  });

  it('gives each session its own transcript', () => {
    const sessions = list();
    const first = sessions.active.chatLog;
    const second = sessions.create(provider(), 'gpt-4o').chatLog;

    expect(second).not.toBe(first);
  });

  it('caps the number of sessions', () => {
    const sessions = list();
    for (let i = 1; i < MAX_SESSIONS; i++) sessions.create(provider(), 'm');

    expect(sessions.list()).toHaveLength(MAX_SESSIONS);
    expect(() => sessions.create(provider(), 'm')).toThrow(/at most/);
  });

  it('reuses the lowest free id after a close', () => {
    // Ids stay single-digit so `/session 3` is unambiguous; without reuse a
    // long-running user would run out while holding only two sessions.
    const sessions = list();
    sessions.create(provider(), 'm'); // 2
    sessions.create(provider(), 'm'); // 3
    sessions.close(2);

    expect(sessions.create(provider(), 'm').id).toBe(2);
  });

  it('refuses to close the last session', () => {
    const sessions = list();
    expect(() => sessions.close(1)).toThrow(/last session/);
    expect(sessions.list()).toHaveLength(1);
  });

  it('moves to another session when the active one is closed', () => {
    const sessions = list();
    sessions.create(provider(), 'm'); // 2, now active

    sessions.close(2);

    expect(sessions.active.id).toBe(1);
  });

  it('leaves the active session alone when closing a different one', () => {
    const sessions = list();
    sessions.create(provider(), 'm'); // 2, active
    sessions.create(provider(), 'm'); // 3, active
    sessions.switchTo(2);

    sessions.close(3);

    expect(sessions.active.id).toBe(2);
  });

  it('labels a session, defaulting to provider and model', () => {
    const sessions = list();
    expect(sessions.describe(sessions.active)).toContain('GitHub Copilot');

    sessions.active.label = 'refactor';
    expect(sessions.describe(sessions.active)).toContain('refactor');
  });
});
