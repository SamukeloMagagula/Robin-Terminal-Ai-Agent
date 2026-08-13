import { describe, it, expect, vi } from 'vitest';
import { createApprovalGate, type ApprovalAnswer } from '../../src/repl/approval-gate';
import type { ConfirmRequest } from '../../src/tools/execute';

function gateAnswering(answers: ApprovalAnswer[]) {
  const ask = vi.fn(async () => answers.shift() ?? 'no');
  const notify = vi.fn();
  return { gate: createApprovalGate({ ask, notify }), ask, notify };
}

const command = (text: string): ConfirmRequest => ({
  kind: 'run_command',
  message: `Run "${text}"?`,
});

describe('createApprovalGate', () => {
  it('approves once without remembering', async () => {
    const { gate, ask } = gateAnswering(['yes', 'yes']);
    expect(await gate.confirm(command('ls'))).toBe(true);
    expect(await gate.confirm(command('ls'))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('stops asking about a kind after "always"', async () => {
    const { gate, ask } = gateAnswering(['always']);
    expect(await gate.confirm(command('ls'))).toBe(true);
    expect(await gate.confirm(command('cat x'))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('refuses an identical repeat without asking again', async () => {
    const { gate, ask, notify } = gateAnswering(['no']);

    expect(await gate.confirm(command('google dp 203'))).toBe(false);
    expect(await gate.confirm(command('google dp 203'))).toBe(false);
    expect(await gate.confirm(command('google dp 203'))).toBe(false);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('already said no'));
  });

  it('still asks about a different request after a refusal', async () => {
    const { gate, ask } = gateAnswering(['no', 'yes']);
    expect(await gate.confirm(command('google dp 203'))).toBe(false);
    expect(await gate.confirm(command('google ai 102'))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('refuses the whole kind for the reply after "never"', async () => {
    const { gate, ask } = gateAnswering(['never']);

    expect(await gate.confirm(command('google dp 203'))).toBe(false);
    expect(await gate.confirm(command('google ai 102'))).toBe(false);
    expect(await gate.confirm({ kind: 'write_file', message: 'Write to a.txt?' })).toBe(false);

    // The command refusals were silent; the write is a different kind and is
    // still the user's to decide.
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('forgets refusals at the start of the next reply, but keeps grants', async () => {
    const { gate, ask } = gateAnswering(['never', 'always']);
    await gate.confirm(command('rm -rf x'));

    gate.beginTurn();
    expect(await gate.confirm(command('rm -rf x'))).toBe(true); // asked again -> "always"
    expect(ask).toHaveBeenCalledTimes(2);

    gate.beginTurn();
    expect(await gate.confirm(command('anything'))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
