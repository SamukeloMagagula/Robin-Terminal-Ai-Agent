import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { filterSlashCommands, promptWithSlashMenu, SLASH_COMMANDS } from '../../src/repl/slash-prompt';

/** A fake TTY pair the prompt can render into, plus a `type()` that feeds it keystrokes. */
function fakeTerminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => unknown };
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  output.isTTY = true;
  output.resume();

  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  };

  return {
    input,
    output,
    settle,
    async type(text: string) {
      for (const ch of text) {
        input.write(ch);
        await settle();
      }
    },
  };
}

describe('promptWithSlashMenu', () => {
  it('resolves with the typed line when no popup is open', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('hey\r');
    expect(await answer).toBe('hey');
  });

  it('resolves with the typed line for a slash command with no matches', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('/het\r');
    expect(await answer).toBe('/het');
  });

  it('resolves with the highlighted command when the popup is open', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('/mod\r');
    expect(await answer).toBe('/model');
  });
});

describe('filterSlashCommands', () => {
  it('returns nothing when the buffer does not start with "/"', () => {
    expect(filterSlashCommands('hello')).toEqual([]);
  });

  it('returns nothing for an empty buffer', () => {
    expect(filterSlashCommands('')).toEqual([]);
  });

  it('returns every command for a bare "/"', () => {
    expect(filterSlashCommands('/')).toEqual(SLASH_COMMANDS);
  });

  it('filters to commands starting with the typed prefix', () => {
    const matches = filterSlashCommands('/s');
    expect(matches.map((m) => m.name)).toEqual(['/system', '/save', '/skill']);
  });

  it('narrows to a single match as more is typed', () => {
    expect(filterSlashCommands('/sk').map((m) => m.name)).toEqual(['/skill']);
  });

  it('matches case-insensitively', () => {
    expect(filterSlashCommands('/MOD').map((m) => m.name)).toEqual(['/model']);
  });

  it('returns nothing for a slash command with no matches', () => {
    expect(filterSlashCommands('/bogus')).toEqual([]);
  });
});
