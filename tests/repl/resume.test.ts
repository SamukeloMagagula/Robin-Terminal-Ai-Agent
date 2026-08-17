import { describe, it, expect } from 'vitest';
import { resumableSession, sessionToOpen } from '../../src/repl/resume';
import type { SessionSnapshot } from '../../src/gateway/protocol';

function session(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    id: 1,
    label: '',
    providerId: 'copilot',
    model: 'gpt-4o',
    cwd: 'C:/work',
    origin: 'terminal',
    running: false,
    toolsEnabled: true,
    autoApprove: false,
    turnCount: 1,
    messageCount: 2,
    updatedAt: '2026-08-17T10:00:00.000Z',
    tokens: { input: 0, output: 0 },
    ...over,
  } as SessionSnapshot;
}

describe('choosing which conversation to open', () => {
  const here = session({ id: 7 });

  it('starts a new one by default', () => {
    // The whole complaint: "robin chat" reads as start a chat, so a new chat
    // must not open onto yesterday's subject matter.
    expect(sessionToOpen([here], 'C:/work', false)).toBeUndefined();
  });

  it('picks up the existing one with --continue', () => {
    expect(sessionToOpen([here], 'C:/work', true)?.id).toBe(7);
  });

  it('leaves the old conversation there to be resumed', () => {
    // Starting fresh must not mean the previous one is gone, or --continue
    // would have nothing to offer a second later.
    expect(sessionToOpen([here], 'C:/work', false)).toBeUndefined();
    expect(resumableSession([here], 'C:/work')?.id).toBe(7);
  });

  it('does not resume a conversation from another directory', () => {
    expect(sessionToOpen([session({ cwd: 'C:/elsewhere' })], 'C:/work', true)).toBeUndefined();
  });

  it('resumes the most recently touched conversation, not the first found', () => {
    // A directory used to hold one long-lived session, so any match was the
    // match. Now every `robin chat` opens a new one, and picking the first
    // meant --continue reliably resumed the oldest conversation there.
    const older = session({ id: 1, updatedAt: '2026-08-01T09:00:00.000Z' });
    const newer = session({ id: 2, updatedAt: '2026-08-17T09:00:00.000Z' });

    expect(sessionToOpen([older, newer], 'C:/work', true)?.id).toBe(2);
    // Order in the list must not decide it.
    expect(sessionToOpen([newer, older], 'C:/work', true)?.id).toBe(2);
  });

  it('skips a conversation nobody said anything in', () => {
    // `robin chat` opened and closed again leaves an empty session behind.
    // Continuing into it is not what the word means.
    const empty = session({ id: 3, messageCount: 0, updatedAt: '2026-08-17T12:00:00.000Z' });
    const real = session({ id: 4, messageCount: 6, updatedAt: '2026-08-17T11:00:00.000Z' });

    expect(sessionToOpen([empty, real], 'C:/work', true)?.id).toBe(4);
    expect(sessionToOpen([empty], 'C:/work', true)).toBeUndefined();
  });

  it('does not join a Telegram or HTTP conversation', () => {
    // Those are created in the daemon's own directory, so matching on the
    // directory alone once meant a terminal silently joined a chat.
    const bridged = session({ origin: 'channel' as SessionSnapshot['origin'] });
    expect(sessionToOpen([bridged], 'C:/work', true)).toBeUndefined();
  });
});
