import { describe, it, expect, vi } from 'vitest';
import { renderEvent } from '../../src/repl/render-events';
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
