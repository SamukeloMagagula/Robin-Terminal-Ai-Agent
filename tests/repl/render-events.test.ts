import { describe, it, expect, vi } from 'vitest';
import { renderEvent, grouped } from '../../src/repl/render-events';
import type { SessionSnapshot } from '../../src/gateway/protocol';

function output() {
  return { text: vi.fn(), muted: vi.fn(), error: vi.fn(), connectionChanged: vi.fn() };
}

const snapshot: SessionSnapshot = {
  id: 1,
  providerId: 'ollama',
  providerName: 'Ollama (local)',
  model: 'llama3.1',
  cwd: '.',
  origin: 'terminal',
  tokens: { input: 0, output: 0 },
  toolsEnabled: true,
  autoApprove: false,
  turnCount: 1,
  busy: false,
  queued: 0,
};

describe('renderEvent', () => {
  it('writes streamed text straight through', () => {
    const out = output();
    renderEvent({ kind: 'text', turnId: 't', delta: 'hello' }, out);
    expect(out.text).toHaveBeenCalledWith('hello');
  });

  it('shows reasoning as muted rather than as the answer', () => {
    const out = output();
    renderEvent({ kind: 'thinking', turnId: 't', delta: 'hmm' }, out);
    expect(out.muted).toHaveBeenCalledWith('hmm');
    expect(out.text).not.toHaveBeenCalled();
  });

  it('shows an auto-approved command so the user knows what ran', () => {
    const out = output();
    renderEvent({ kind: 'tool.auto_approved', turnId: 't', command: 'dir' }, out);
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('dir'));
  });

  it('shows command output as it arrives', () => {
    const out = output();
    renderEvent({ kind: 'tool.output', turnId: 't', chunk: 'file.txt' }, out);
    expect(out.muted).toHaveBeenCalledWith('file.txt');
  });

  it('reports a fallback with the model it moved to', () => {
    const out = output();
    renderEvent(
      { kind: 'fallback', turnId: 't', message: '429', providerName: 'Ollama', model: 'llama3.1' },
      out
    );
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('llama3.1'));
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('429'));
  });

  it('says how much history was dropped', () => {
    const out = output();
    renderEvent({ kind: 'trim', turnId: 't', dropped: 4, limit: 12288 }, out);
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('4'));
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('12288'));
  });

  it('reports a failed turn as an error', () => {
    const out = output();
    renderEvent(
      {
        kind: 'turn.finished',
        turnId: 't',
        ok: false,
        aborted: false,
        providerName: 'X',
        model: 'y',
        error: 'boom',
      },
      out
    );
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('announces a model change so the status line stays true', () => {
    const out = output();
    renderEvent({ kind: 'session.changed', snapshot }, out);
    expect(out.connectionChanged).toHaveBeenCalledWith('Ollama (local)', 'llama3.1');
  });

  it('says nothing at all for a clean finish — the text already said it', () => {
    const out = output();
    renderEvent(
      {
        kind: 'turn.finished',
        turnId: 't',
        ok: true,
        aborted: false,
        providerName: 'X',
        model: 'y',
      },
      out
    );
    expect(out.error).not.toHaveBeenCalled();
    expect(out.muted).not.toHaveBeenCalled();
    expect(out.text).not.toHaveBeenCalled();
  });

  it('says so when the turn was interrupted', () => {
    const out = output();
    renderEvent(
      {
        kind: 'turn.finished',
        turnId: 't',
        ok: true,
        aborted: true,
        providerName: 'X',
        model: 'y',
      },
      out
    );
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('Interrupted'));
  });

  // These two need a prompt, not a line of output, so run-repl handles them.
  it.each(['approval.request', 'approval.resolved', 'turn.started'])(
    'leaves %s to the caller',
    (kind) => {
      const out = output();
      renderEvent({ kind } as never, out);
      expect(out.text).not.toHaveBeenCalled();
      expect(out.muted).not.toHaveBeenCalled();
      expect(out.error).not.toHaveBeenCalled();
    }
  );
});

describe('renderEvent and token counts', () => {
  it('shows what the turn cost when the provider said', () => {
    const out = output();
    renderEvent(
      {
        kind: 'turn.finished',
        turnId: 't',
        ok: true,
        aborted: false,
        providerName: 'X',
        model: 'y',
        tokens: { input: 1234, output: 56 },
      },
      out
    );
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('1,234 in'));
    expect(out.muted).toHaveBeenCalledWith(expect.stringContaining('56 out'));
  });

  // "0 tokens" is a number someone could act on; "we were not told" is not.
  it('says nothing when the provider reported nothing', () => {
    const out = output();
    renderEvent(
      { kind: 'turn.finished', turnId: 't', ok: true, aborted: false, providerName: 'X', model: 'y' },
      out
    );
    expect(out.muted).not.toHaveBeenCalled();
  });

  it('does not print a cost line over an error', () => {
    const out = output();
    renderEvent(
      {
        kind: 'turn.finished',
        turnId: 't',
        ok: false,
        aborted: false,
        providerName: 'X',
        model: 'y',
        error: 'boom',
        tokens: { input: 10, output: 0 },
      },
      out
    );
    expect(out.error).toHaveBeenCalled();
    expect(out.muted).not.toHaveBeenCalled();
  });
});

describe('grouped', () => {
  // toLocaleString would give "1 234" on an en-ZA machine and "1,234" on a
  // US one — the same code printing differently for two people.
  it.each([
    [0, '0'],
    [42, '42'],
    [1234, '1,234'],
    [1234567, '1,234,567'],
  ])('formats %i as %s regardless of locale', (value, expected) => {
    expect(grouped(value)).toBe(expected);
  });
});
