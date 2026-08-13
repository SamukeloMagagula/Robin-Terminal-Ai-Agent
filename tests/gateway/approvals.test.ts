import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalRegistry, type PendingApproval } from '../../src/gateway/approvals';
import type { ConfirmRequest } from '../../src/tools/execute';

const terminal = { surface: 'terminal' };
const telegram = { surface: 'telegram', who: '@sam' };

const command = (text: string): ConfirmRequest => ({
  kind: 'run_command',
  message: `Run "${text}"?`,
});

function registry(approverCount = 1) {
  const seen: PendingApproval[] = [];
  const resolved = vi.fn();
  const reg = new ApprovalRegistry({
    broadcast: (pending) => {
      seen.push(pending);
      return approverCount;
    },
    resolved,
  });
  return { reg, seen, resolved };
}

describe('ApprovalRegistry', () => {
  it('resolves true when a client approves', async () => {
    const { reg, seen } = registry();
    const answer = reg.confirmFor(1, terminal, false)(command('ls'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'terminal-1');

    expect(await answer).toBe(true);
  });

  it('resolves false when a client refuses', async () => {
    const { reg, seen } = registry();
    const answer = reg.confirmFor(1, terminal, false)(command('ls'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');

    expect(await answer).toBe(false);
  });

  it('tells clients the approval is settled so they can close the box', async () => {
    const { reg, seen, resolved } = registry();
    const answer = reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    reg.answer(seen[0].id, true, 'terminal-1');
    await answer;

    expect(resolved).toHaveBeenCalledWith(seen[0], true, 'terminal-1');
  });

  it('ignores a second answer to a settled approval', async () => {
    const { reg, seen } = registry(2);
    const answer = reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(reg.answer(seen[0].id, true, 'terminal-1')).toBe(true);
    expect(reg.answer(seen[0].id, false, 'terminal-2')).toBe(false);
    expect(await answer).toBe(true);
  });

  it('reports an answer to an approval it has never heard of', () => {
    const { reg } = registry();
    expect(reg.answer('made-up', true, 'terminal-1')).toBe(false);
  });

  // Today's `serve` behaviour, preserved: nobody at the keyboard means no.
  it('denies immediately when no client can approve', async () => {
    const { reg } = registry(0);
    expect(await reg.confirmFor(1, telegram, false)(command('rm -rf /'))).toBe(false);
  });

  it('approves without asking anyone when the session is auto-approve', async () => {
    const { reg, seen } = registry(1);
    expect(await reg.confirmFor(1, telegram, true)(command('ls'))).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('carries the origin, so the box can say where the request came from', async () => {
    const { reg, seen } = registry();
    void reg.confirmFor(3, telegram, false)(command('npm publish'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0].origin).toEqual(telegram);
    expect(seen[0].sessionId).toBe(3);
  });

  it('lists what is still pending', async () => {
    const { reg, seen } = registry();
    void reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(reg.pending()).toHaveLength(1);
    reg.answer(seen[0].id, true, 'terminal-1');
    expect(reg.pending()).toEqual([]);
  });

  it('refuses an identical repeat without asking again', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const first = confirm(command('google dp 203'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    expect(await first).toBe(false);

    expect(await confirm(command('google dp 203'))).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('still asks about a different request after a refusal', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const first = confirm(command('google dp 203'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    await first;

    void confirm(command('google ai 102'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
  });

  it('does not remember approvals, only refusals', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const first = confirm(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'terminal-1');
    await first;

    void confirm(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
  });

  it('forgets refusals when the next turn starts', async () => {
    const { reg, seen } = registry();
    const confirm = reg.confirmFor(1, terminal, false);

    const first = confirm(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    await first;

    reg.beginTurn(1);
    void confirm(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
  });

  it("keeps one session's refusals out of another's", async () => {
    const { reg, seen } = registry();
    const one = reg.confirmFor(1, terminal, false);
    const two = reg.confirmFor(2, terminal, false);

    const first = one(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, false, 'terminal-1');
    await first;

    void two(command('ls'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
  });
});

describe('ApprovalRegistry timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('denies an approval nobody answers', async () => {
    const seen: PendingApproval[] = [];
    const reg = new ApprovalRegistry({
      broadcast: (pending) => {
        seen.push(pending);
        return 1;
      },
      resolved: vi.fn(),
      timeoutMs: 1000,
    });

    const answer = reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.advanceTimersByTimeAsync(1001);

    expect(await answer).toBe(false);
    expect(reg.pending()).toEqual([]);
  });

  it('reports a timeout as its own reason, not as a refusal by a person', async () => {
    const resolved = vi.fn();
    const reg = new ApprovalRegistry({
      broadcast: () => 1,
      resolved,
      timeoutMs: 1000,
    });

    const answer = reg.confirmFor(1, terminal, false)(command('ls'));
    await vi.advanceTimersByTimeAsync(1001);
    await answer;

    expect(resolved).toHaveBeenCalledWith(expect.anything(), false, 'timeout');
  });
});
