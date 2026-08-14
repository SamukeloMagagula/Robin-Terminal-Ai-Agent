import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore, type PersistedSession } from '../../src/gateway/session-store';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-sessions-'));
});

function session(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: 1,
    providerId: 'copilot',
    model: 'gpt-4o',
    cwd: 'C:/work',
    toolsEnabled: true,
    autoApprove: false,
    turnCount: 2,
    history: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SessionStore', () => {
  it('has nothing to load before anything is saved', async () => {
    expect(await new SessionStore(dir).load()).toEqual([]);
  });

  it('round-trips a session', async () => {
    const store = new SessionStore(dir);
    const saved = session();

    await store.save(saved);

    expect(await new SessionStore(dir).load()).toEqual([saved]);
  });

  it('keeps sessions in id order, however they were written', async () => {
    const store = new SessionStore(dir);
    await store.save(session({ id: 3 }));
    await store.save(session({ id: 1 }));
    await store.save(session({ id: 2 }));

    expect((await store.load()).map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it('overwrites rather than duplicating when a session is saved again', async () => {
    const store = new SessionStore(dir);
    await store.save(session({ turnCount: 1 }));
    await store.save(session({ turnCount: 9 }));

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].turnCount).toBe(9);
  });

  it('forgets a closed session', async () => {
    const store = new SessionStore(dir);
    await store.save(session({ id: 1 }));
    await store.save(session({ id: 2 }));

    await store.remove(1);

    expect((await store.load()).map((s) => s.id)).toEqual([2]);
  });

  it('does not mind being asked to forget a session that is not there', async () => {
    await expect(new SessionStore(dir).remove(99)).resolves.toBeUndefined();
  });

  it('carries the transcript location, so one conversation stays one file', async () => {
    const store = new SessionStore(dir);
    const transcript = { path: 'C:/chats/robin-chat-2026-08-14_10-00-00.md', startedAt: '2026-08-14T10:00:00.000Z' };

    await store.save(session({ transcript }));

    expect((await store.load())[0].transcript).toEqual(transcript);
  });

  // A history holds the contents of every file the model read. It belongs in
  // the private tree with the same permissions transcripts already get.
  it('writes with owner-only permissions', async () => {
    const store = new SessionStore(dir);
    await store.save(session());

    const [file] = await fs.readdir(dir);
    const stat = await fs.stat(path.join(dir, file));
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o077).toBe(0);
    }
    expect(stat.isFile()).toBe(true);
  });

  // Fails closed, like every other store here: one unreadable file must not
  // cost the user every other conversation.
  it('skips a corrupt file and still loads the rest', async () => {
    const store = new SessionStore(dir);
    await store.save(session({ id: 1 }));
    await store.save(session({ id: 2 }));
    await fs.writeFile(path.join(dir, 'session-1.json'), 'not json at all', 'utf-8');

    expect((await store.load()).map((s) => s.id)).toEqual([2]);
  });

  it('skips a file whose shape is wrong', async () => {
    const store = new SessionStore(dir);
    await fs.writeFile(
      path.join(dir, 'session-5.json'),
      JSON.stringify({ id: 'five', providerId: 'copilot' }),
      'utf-8'
    );

    expect(await store.load()).toEqual([]);
  });

  it('skips a history containing something that is not a message', async () => {
    const store = new SessionStore(dir);
    const bad = { ...session(), history: [{ role: 'user' }] };
    await fs.writeFile(path.join(dir, 'session-1.json'), JSON.stringify(bad), 'utf-8');

    expect(await store.load()).toEqual([]);
  });

  // Otherwise every directory Robin was ever run in accumulates a session
  // nobody will open again, and /session becomes unreadable.
  it('drops sessions untouched for longer than the keep-for window', async () => {
    const store = new SessionStore(dir);
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await store.save(session({ id: 1, updatedAt: old }));
    await store.save(session({ id: 2 }));

    expect((await store.load()).map((s) => s.id)).toEqual([2]);
  });

  it('deletes the stale files it drops rather than reading them forever', async () => {
    const store = new SessionStore(dir);
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await store.save(session({ id: 1, updatedAt: old }));

    await store.load();

    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('ignores files that are not sessions', async () => {
    const store = new SessionStore(dir);
    await store.save(session());
    await fs.writeFile(path.join(dir, 'notes.txt'), 'unrelated', 'utf-8');

    expect(await store.load()).toHaveLength(1);
  });
});
