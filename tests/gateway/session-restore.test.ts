import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService } from '../../src/gateway/session-service';
import { SessionStore } from '../../src/gateway/session-store';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { Provider } from '../../src/providers/types';

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

function fakeProvider(id = 'copilot', name = 'GitHub Copilot'): Provider {
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['gpt-4o']),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'answered' };
    }),
  } as unknown as Provider;
}

/** A service sharing one sessions directory, as a restarted daemon would. */
async function service(dir: string, providers = [fakeProvider()]) {
  const sessions = new SessionStore(dir);
  const svc = new SessionService({
    providers,
    approvals: new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() }),
    emit: vi.fn(),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
      sessions,
    },
  });
  await svc.restore();
  return svc;
}

async function sessionsDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'robin-restore-'));
}

describe('SessionService persistence', () => {
  it('brings a conversation back after a restart', async () => {
    const dir = await sessionsDir();
    const first = await service(dir);
    const created = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: 'C:/work' });
    first.sendPrompt(created.id, 'remember this', { surface: 'terminal' });
    await first.idle();

    await first.flush();
    const second = await service(dir);

    expect(second.list()).toHaveLength(1);
    expect(second.history(created.id).map((m) => m.content)).toEqual([
      'remember this',
      'answered',
    ]);
  });

  it('restores what the session was, not just what was said', async () => {
    const dir = await sessionsDir();
    const first = await service(dir);
    const created = first.create({
      providerId: 'copilot',
      model: 'gpt-4o',
      cwd: 'C:/work',
      label: 'the good one',
      autoApprove: true,
    });
    first.update(created.id, { toolsEnabled: false, systemPrompt: 'be terse' });
    // Said something, because only a conversation with content is kept.
    first.append(created.id, { role: 'user', content: 'hello' });

    await first.flush();
    const restored = (await service(dir)).snapshot(created.id);

    expect(restored).toMatchObject({
      label: 'the good one',
      cwd: 'C:/work',
      model: 'gpt-4o',
      toolsEnabled: false,
      systemPrompt: 'be terse',
      autoApprove: true,
    });
  });

  // A restored session must never look mid-turn: whatever was running when the
  // daemon died is not running now.
  it('restores a session as idle, whatever it was doing', async () => {
    const dir = await sessionsDir();
    const first = await service(dir);
    const created = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    first.sendPrompt(created.id, 'hi', { surface: 'terminal' });
    await first.idle();

    await first.flush();
    const restored = (await service(dir)).snapshot(created.id);

    expect(restored.busy).toBe(false);
    expect(restored.queued).toBe(0);
  });

  it('does not hand a new session an id a restored one is using', async () => {
    const dir = await sessionsDir();
    const first = await service(dir);
    const a = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    const b = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    // Both have to say something to be restored at all, and only a restored
    // session can have its id handed out twice.
    first.append(a.id, { role: 'user', content: 'one' });
    first.append(b.id, { role: 'user', content: 'two' });

    await first.flush();
    const second = await service(dir);
    const fresh = second.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    expect(fresh.id).not.toBe(a.id);
    expect(fresh.id).not.toBe(b.id);
  });

  it('forgets a session that was closed', async () => {
    const dir = await sessionsDir();
    const first = await service(dir);
    const created = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    first.close(created.id);

    await first.flush();
    expect((await service(dir)).list()).toEqual([]);
  });

  it('does not bring a cleared conversation back', async () => {
    // Clearing used to save the empty shell, so a restart handed back a
    // session with nothing in it. Now the file goes: an empty conversation is
    // not something to restore, and blank entries in /session are noise. What
    // matters either way is that the cleared messages do not come back.
    const dir = await sessionsDir();
    const first = await service(dir);
    const created = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    first.append(created.id, { role: 'user', content: 'said something' });
    first.clear(created.id);

    await first.flush();
    expect((await service(dir)).list()).toEqual([]);
  });

  it('does not keep a conversation nobody said anything in', async () => {
    // `robin chat` opens one every time it starts. Persisting those fills
    // /session with blank entries that differ only by number.
    const dir = await sessionsDir();
    const first = await service(dir);
    first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    await first.flush();
    expect((await service(dir)).list()).toEqual([]);
  });

  it('persists a loaded conversation', async () => {
    const dir = await sessionsDir();
    const first = await service(dir);
    const created = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    first.setHistory(created.id, [{ role: 'user', content: 'from a save file' }]);

    await first.flush();
    expect((await service(dir)).history(created.id)).toEqual([
      { role: 'user', content: 'from a save file' },
    ]);
  });

  // A provider can be removed from a build, or renamed. The conversation is
  // still readable; it just cannot be continued as-is.
  it('drops a session whose provider no longer exists rather than failing to start', async () => {
    const dir = await sessionsDir();
    const first = await service(dir, [fakeProvider('ollama', 'Ollama (local)')]);
    first.create({ providerId: 'ollama', model: 'llama3.1', cwd: '.' });

    await first.flush();
    const second = await service(dir, [fakeProvider('copilot', 'GitHub Copilot')]);

    expect(second.list()).toEqual([]);
  });

  it('keeps one transcript for one conversation across a restart', async () => {
    const dir = await sessionsDir();
    const first = await service(dir);
    const created = first.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    first.sendPrompt(created.id, 'hi', { surface: 'terminal' });
    await first.idle();
    const before = first.transcriptPathForTest(created.id);

    await first.flush();
    const second = await service(dir);
    second.sendPrompt(created.id, 'again', { surface: 'terminal' });
    await second.idle();

    expect(second.transcriptPathForTest(created.id)).toBe(before);
    expect(before).toBeDefined();
  });

  it('starts clean when there is nothing to restore', async () => {
    expect((await service(await sessionsDir())).list()).toEqual([]);
  });
});
