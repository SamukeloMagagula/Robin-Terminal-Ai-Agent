import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { GatewayEvent } from '../../src/gateway/protocol';
import type { Provider } from '../../src/providers/types';

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

function providerWith(chat: unknown): Provider {
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['gpt-4o']),
    chat,
  } as unknown as Provider;
}

/** Yields the given text, one chunk at a time. */
function textProvider(chunks: string[]): Provider {
  return providerWith(
    vi.fn().mockImplementation(async function* () {
      for (const chunk of chunks) yield { type: 'text', text: chunk };
    })
  );
}

function service(provider: Provider, approvals?: ApprovalRegistry) {
  const events: { sessionId: number; event: GatewayEvent }[] = [];
  const svc = new SessionService({
    providers: [provider],
    approvals:
      approvals ?? new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() }),
    emit: (sessionId, event) => events.push({ sessionId, event }),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
    },
  });
  return { svc, events };
}

const terminal = { surface: 'terminal' };
const kinds = (events: { event: GatewayEvent }[]): string[] =>
  events.map((entry) => entry.event.kind);

describe('SessionService turns', () => {
  it('accepts a prompt immediately and streams the reply as events', async () => {
    const { svc, events } = service(textProvider(['Hello ', 'there']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const accepted = svc.sendPrompt(session.id, 'hi', terminal);
    expect(accepted.queuePosition).toBe(0);
    expect(accepted.turnId).toMatch(/\S/);

    await svc.idle();

    expect(kinds(events)).toEqual(['turn.started', 'text', 'text', 'turn.finished']);
    const deltas = events
      .filter((entry) => entry.event.kind === 'text')
      .map((entry) => (entry.event as { delta: string }).delta);
    expect(deltas.join('')).toBe('Hello there');
  });

  it('scopes every event to the session it belongs to', async () => {
    const { svc, events } = service(textProvider(['a']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    expect(events.every((entry) => entry.sessionId === session.id)).toBe(true);
  });

  it('keeps the conversation, so attach shows it afterwards', async () => {
    const { svc } = service(textProvider(['answered']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    expect(svc.attach(session.id).history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answered' },
    ]);
  });

  it('runs one turn at a time and reports the queue position', async () => {
    const { svc } = service(textProvider(['a']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const first = svc.sendPrompt(session.id, 'one', terminal);
    const second = svc.sendPrompt(session.id, 'two', terminal);
    const third = svc.sendPrompt(session.id, 'three', terminal);

    expect(first.queuePosition).toBe(0);
    expect(second.queuePosition).toBe(1);
    expect(third.queuePosition).toBe(2);

    await svc.idle();

    // Serialised, not interleaved: three prompts and three replies, in the
    // order they were sent. Two turns mutating one history array concurrently
    // is the corruption this queue exists to prevent.
    expect(svc.attach(session.id).history.map((m) => m.content)).toEqual([
      'one',
      'a',
      'two',
      'a',
      'three',
      'a',
    ]);
  });

  it('keeps two sessions out of each other\'s way', async () => {
    const { svc } = service(textProvider(['a']));
    const one = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });
    const two = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(one.id, 'to one', terminal);
    // A second session is not queued behind the first — they are separate
    // conversations that happen to share a daemon.
    expect(svc.sendPrompt(two.id, 'to two', terminal).queuePosition).toBe(0);

    await svc.idle();

    expect(svc.attach(one.id).history[0].content).toBe('to one');
    expect(svc.attach(two.id).history[0].content).toBe('to two');
  });

  it('reports busy in the snapshot while a turn runs', async () => {
    const { svc } = service(textProvider(['a']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    expect(svc.snapshot(session.id).busy).toBe(true);

    await svc.idle();
    expect(svc.snapshot(session.id).busy).toBe(false);
  });

  it('reports a failed turn through turn.finished rather than throwing', async () => {
    const { svc, events } = service(
      providerWith(
        vi.fn().mockImplementation(async function* () {
          throw new Error('boom');
        })
      )
    );
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    const finished = events.at(-1)?.event as { kind: string; ok: boolean; error?: string };
    expect(finished.kind).toBe('turn.finished');
    expect(finished.ok).toBe(false);
    expect(finished.error).toContain('boom');
  });

  it('survives a prompt for a session closed while it was queued', async () => {
    const { svc } = service(textProvider(['a']));
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'one', terminal);
    svc.sendPrompt(session.id, 'two', terminal);
    svc.close(session.id);

    await expect(svc.idle()).resolves.toBeUndefined();
  });

  it('interrupts the turn it is given', async () => {
    const { svc, events } = service(
      providerWith(
        vi.fn().mockImplementation(async function* (
          _model: string,
          _history: unknown,
          _tools: unknown,
          signal?: AbortSignal
        ) {
          yield { type: 'text', text: 'partial' };
          // Long enough that waitFor's poll interval lands mid-turn. A shorter
          // sleep means the turn is over before the test can interrupt it, and
          // the test fails for a reason that has nothing to do with the code.
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield { type: 'text', text: ' and the rest' };
        })
      )
    );
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    const accepted = svc.sendPrompt(session.id, 'hi', terminal);
    await vi.waitFor(() => expect(kinds(events)).toContain('text'));
    expect(svc.interrupt(accepted.turnId)).toBe(true);
    await svc.idle();

    const finished = events.at(-1)?.event as { kind: string; aborted: boolean };
    expect(finished.kind).toBe('turn.finished');
    expect(finished.aborted).toBe(true);
  });

  it('reports an interrupt for a turn that is not running', () => {
    const { svc } = service(textProvider(['a']));
    expect(svc.interrupt('not-a-turn')).toBe(false);
  });

  it('starts each turn with a clean approval slate', async () => {
    const approvals = new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() });
    const beginTurn = vi.spyOn(approvals, 'beginTurn');
    const { svc } = service(textProvider(['a']), approvals);
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    expect(beginTurn).toHaveBeenCalledWith(session.id);
  });

  it('follows the model a fallback landed on, and says so', async () => {
    // One provider, two models: the first refuses, the fallback chain moves to
    // the second, and the session must not keep claiming the first.
    let call = 0;
    const provider = providerWith(
      vi.fn().mockImplementation(async function* (model: string) {
        call += 1;
        if (call === 1) throw new Error('boom');
        yield { type: 'text', text: `answered by ${model}` };
      })
    );
    provider.listModels = vi.fn().mockResolvedValue(['gpt-4o', 'gpt-5']) as never;
    const { svc, events } = service(provider);
    const session = svc.create({ providerId: 'copilot', model: 'gpt-4o', cwd: '.' });

    svc.sendPrompt(session.id, 'hi', terminal);
    await svc.idle();

    expect(kinds(events)).toContain('session.changed');
    expect(svc.snapshot(session.id).model).toBe('gpt-5');
  });
});
