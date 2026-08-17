import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { Provider } from '../../src/providers/types';

function fakeProvider(id: string, name: string): Provider {
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['m1']),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'ok' };
    }),
  } as unknown as Provider;
}

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

function service(emit = vi.fn()) {
  const providers = [
    fakeProvider('copilot', 'GitHub Copilot'),
    fakeProvider('ollama', 'Ollama (local)'),
  ];
  const svc = new SessionService({
    providers,
    approvals: new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() }),
    emit,
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
    },
  });
  return { svc, emit, providers };
}

describe('SessionService sessions', () => {
  it('starts with no sessions', () => {
    expect(service().svc.list()).toEqual([]);
  });

  it('creates a session and reports it', () => {
    const { svc } = service();
    const snapshot = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: 'C:/work' });

    expect(snapshot).toMatchObject({
      id: 1,
      providerId: 'copilot',
      providerName: 'GitHub Copilot',
      model: 'gpt-4o',
      cwd: 'C:/work',
      toolsEnabled: true,
      autoApprove: false,
      turnCount: 0,
      busy: false,
      queued: 0,
    });
    expect(svc.list()).toHaveLength(1);
  });

  it('carries autoApprove when the caller asks for it', () => {
    const { svc } = service();
    const snapshot = svc.create({
      providerId: 'copilot',
      model: 'gpt-4o',
      cwd: '.',
      autoApprove: true,
    });
    expect(snapshot.autoApprove).toBe(true);
  });

  it('rejects a provider it does not know', () => {
    const { svc } = service();
    expect(() => svc.create({ providerId: 'nope', model: 'm', cwd: '.' })).toThrow(/nope/);
  });

  it('attaches with an empty history on a fresh session', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    expect(svc.attach(created.id)).toEqual({ snapshot: created, history: [] });
  });

  it('updates the model and announces the change', () => {
    const { svc, emit } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const updated = svc.update(created.id, { model: 'gpt-5' });

    expect(updated.model).toBe('gpt-5');
    expect(emit).toHaveBeenCalledWith(
      created.id,
      expect.objectContaining({ kind: 'session.changed' })
    );
  });

  // Switching connection resets history: the model on the other side has not
  // seen any of it. The same rule the REPL has always had.
  it('clears history when the provider changes', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.append(created.id, { role: 'user', content: 'hi' });

    svc.update(created.id, { providerId: 'ollama', model: 'llama3.1' });

    expect(svc.attach(created.id).history).toEqual([]);
  });

  it('leaves history alone when only the label changes', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.append(created.id, { role: 'user', content: 'hi' });

    const updated = svc.update(created.id, { label: 'the good one' });

    expect(updated.label).toBe('the good one');
    expect(svc.attach(created.id).history).toHaveLength(1);
  });

  it('clears history on request without changing the model', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.append(created.id, { role: 'user', content: 'hi' });

    const cleared = svc.clear(created.id);

    expect(cleared.model).toBe('gpt-4o');
    expect(svc.attach(created.id).history).toEqual([]);
  });

  it('sets and clears the system prompt', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    expect(svc.update(created.id, { systemPrompt: 'be terse' }).systemPrompt).toBe('be terse');
    // null is the only way to say "remove it" over a wire protocol, where
    // undefined means "leave it alone".
    expect(svc.update(created.id, { systemPrompt: null }).systemPrompt).toBeUndefined();
  });

  it('toggles tools', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    expect(svc.update(created.id, { toolsEnabled: false }).toolsEnabled).toBe(false);
  });

  it('closes a session', () => {
    const { svc } = service();
    const a = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    const b = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.close(a.id);

    expect(svc.list().map((s) => s.id)).toEqual([b.id]);
  });

  // The REPL refused to close the last session because it had nowhere to land.
  // A daemon holding nothing is a normal, quiet state.
  it('allows closing the last session', () => {
    const { svc } = service();
    const only = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.close(only.id);
    expect(svc.list()).toEqual([]);
  });

  it('hands back the history for /copy and /save', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.append(created.id, { role: 'user', content: 'hi' });

    expect(svc.history(created.id)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('hands back a copy, so a client cannot mutate the daemon by accident', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.append(created.id, { role: 'user', content: 'hi' });

    svc.history(created.id).push({ role: 'user', content: 'smuggled' });

    expect(svc.history(created.id)).toHaveLength(1);
  });

  it('replaces the history for /load, and starts a new transcript', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.append(created.id, { role: 'user', content: 'the old conversation' });

    svc.setHistory(created.id, [
      { role: 'user', content: 'the loaded one' },
      { role: 'assistant', content: 'hello again' },
    ]);

    expect(svc.history(created.id).map((m) => m.content)).toEqual([
      'the loaded one',
      'hello again',
    ]);
  });

  it('announces a loaded conversation, so other clients redraw', () => {
    const { svc, emit } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    emit.mockClear();

    svc.setHistory(created.id, [{ role: 'user', content: 'loaded' }]);

    expect(emit).toHaveBeenCalledWith(
      created.id,
      expect.objectContaining({ kind: 'session.changed' })
    );
  });

  it('sets the personality', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.update(created.id, { personality: 'be terse' });
    expect(svc.personality(created.id)).toBe('be terse');

    svc.update(created.id, { personality: null });
    expect(svc.personality(created.id)).toBeUndefined();
  });

  it('reports a missing session by id rather than throwing something opaque', () => {
    const { svc } = service();
    expect(() => svc.attach(42)).toThrow(/42/);
    expect(() => svc.close(42)).toThrow(/42/);
    expect(() => svc.update(42, { model: 'x' })).toThrow(/42/);
  });

  it('gives each session its own id, and does not reuse a closed one', () => {
    const { svc } = service();
    const first = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    svc.close(first.id);
    const second = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    // Reusing an id would let a client that still holds the old one address a
    // conversation it has never seen.
    expect(second.id).not.toBe(first.id);
  });
});

describe('SessionService origins', () => {
  it('records a session as a terminal session by default', () => {
    const { svc } = service();
    expect(svc.create({ providerId: 'copilot', model: 'm', cwd: '.' }).origin).toBe('terminal');
  });

  // Without this a terminal reopened in the daemon's own directory reuses
  // whatever session happens to share that cwd — and the bridge and the HTTP
  // API both create theirs there. Typing into a Telegram chat's conversation
  // by accident is not a shared session, it is a wrong one.
  it('keeps a channel session distinguishable from a terminal one', () => {
    const { svc } = service();
    const chat = svc.create({ providerId: 'copilot', model: 'm', cwd: '.', origin: 'channel' });
    const terminal = svc.create({ providerId: 'copilot', model: 'm', cwd: '.' });

    expect(chat.origin).toBe('channel');
    expect(terminal.origin).toBe('terminal');
    expect(svc.list().filter((s) => s.origin === 'terminal')).toHaveLength(1);
  });

  it('records an http session as its own kind', () => {
    const { svc } = service();
    expect(
      svc.create({ providerId: 'copilot', model: 'm', cwd: '.', origin: 'http' }).origin
    ).toBe('http');
  });
});

describe('SessionService working directory', () => {
  it('re-binds where tools run', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: 'C:/old' });

    expect(svc.update(created.id, { cwd: 'C:/new' }).cwd).toBe('C:/new');
  });

  // A cd is not a change of model. Clearing the conversation for it would be a
  // surprising price to pay for moving directory.
  it('keeps the conversation when only the directory moves', () => {
    const { svc } = service();
    const created = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: 'C:/old' });
    svc.append(created.id, { role: 'user', content: 'said earlier' });

    svc.update(created.id, { cwd: 'C:/new' });

    expect(svc.history(created.id)).toHaveLength(1);
  });
});
