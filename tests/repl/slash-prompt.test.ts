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

const UP = '[A';
const DOWN = '[B';

describe('promptWithSlashMenu — up/down history', () => {
  /** Feeds an escape sequence as one unit; typing it char-by-char is not a keypress. */
  async function press(term: ReturnType<typeof fakeTerminal>, seq: string) {
    term.input.write(seq);
    await term.settle();
  }

  it('recalls the newest entry on up', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['first', 'second'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await press(term, UP);
    await term.type('\r');
    expect(await answer).toBe('second');
  });

  it('walks further back on repeated up', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['first', 'second', 'third'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await press(term, UP);
    await press(term, UP);
    await term.type('\r');
    expect(await answer).toBe('second');
  });

  it('stops at the oldest entry rather than wrapping around', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['first', 'second'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    for (let i = 0; i < 5; i++) await press(term, UP);
    await term.type('\r');
    expect(await answer).toBe('first');
  });

  it('comes back toward the present on down', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['first', 'second', 'third'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await press(term, UP);
    await press(term, UP);
    await press(term, DOWN);
    await term.type('\r');
    expect(await answer).toBe('third');
  });

  // The "present" half of the request: an unsent draft must survive the trip.
  it('restores an unsent draft when coming back down to the present', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['old one'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await term.type('my draft');
    await press(term, UP);
    await press(term, DOWN);
    await term.type('\r');
    expect(await answer).toBe('my draft');
  });

  it('does nothing on up when there is no history', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({ history: [] }, { input: term.input, output: term.output });
    await term.settle();
    await term.type('typed');
    await press(term, UP);
    await term.type('\r');
    expect(await answer).toBe('typed');
  });

  it('does nothing on down while already at the present', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['old one'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await term.type('typed');
    await press(term, DOWN);
    await term.type('\r');
    expect(await answer).toBe('typed');
  });

  // Recalling a slash command must not reopen the popup, or the next `up`
  // would move the popup selection and history navigation would jam.
  it('does not reopen the popup when recalling a slash command', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['/model', '/random'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await press(term, UP); // -> /random
    await press(term, UP); // -> /model, not a popup move
    await term.type('\r');
    expect(await answer).toBe('/model');
  });

  it('still drives the popup with up/down while it is open', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['unused entry'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await term.type('/s'); // popup opens: /system, /save, /skill
    await press(term, DOWN); // -> /save
    await term.type('\r');
    expect(await answer).toBe('/save');
  });

  it('defaults to no history when the config omits it', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('plain');
    await press(term, UP);
    await term.type('\r');
    expect(await answer).toBe('plain');
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
    // Asserted as a set rather than an exact list: the point is that every
    // /s command is offered and nothing else is, not the order they happen to
    // sit in SLASH_COMMANDS — which changes whenever a command is added.
    const names = matches.map((m) => m.name);
    expect(names).toContain('/system');
    expect(names).toContain('/save');
    expect(names).toContain('/skill');
    expect(names).toContain('/session');
    expect(names.every((n) => n.startsWith('/s'))).toBe(true);
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

describe('multiline input', () => {
  it('submits on Enter as before', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('one line\r');
    expect(await answer).toBe('one line');
  });

  it('inserts a newline on Alt+Enter instead of submitting', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('first');
    term.input.write('\x1b\r'); // Alt+Enter
    await term.settle();
    await term.type('second\r');
    expect(await answer).toBe('first\nsecond');
  });

  it('continues onto the next line after a trailing backslash', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu({}, { input: term.input, output: term.output });
    await term.settle();
    await term.type('first\\\r');
    await term.type('second\r');
    expect(await answer).toBe('first\nsecond');
  });

  it('up moves between lines before reaching input history', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['an older command'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    await term.type('first');
    term.input.write('\x1b\r');
    await term.settle();
    await term.type('second');

    term.input.write('\x1b[A'); // up: to line one, NOT history
    await term.settle();
    term.input.write('\r');

    expect(await answer).toBe('first\nsecond');
  });

  it('reaches input history from the first line', async () => {
    const term = fakeTerminal();
    const answer = promptWithSlashMenu(
      { history: ['an older command'] },
      { input: term.input, output: term.output }
    );
    await term.settle();
    term.input.write('\x1b[A');
    await term.settle();
    term.input.write('\r');

    expect(await answer).toBe('an older command');
  });
});
