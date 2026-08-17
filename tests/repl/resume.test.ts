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
    turnCount: 0,
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

  it('does not join a Telegram or HTTP conversation', () => {
    // Those are created in the daemon's own directory, so matching on the
    // directory alone once meant a terminal silently joined a chat.
    const bridged = session({ origin: 'channel' as SessionSnapshot['origin'] });
    expect(sessionToOpen([bridged], 'C:/work', true)).toBeUndefined();
  });
});
