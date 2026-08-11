import { createPrompt, useState, useKeypress, isEnterKey } from '@inquirer/core';
import { USER_INPUT_COLOR, RESET_COLOR, assistantColor, mutedColor } from '../ui/theme.js';
import { LineBuffer } from './line-buffer.js';

export interface SlashCommandEntry {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandEntry[] = [
  { name: '/help', description: 'list commands' },
  { name: '/model', description: 'switch model on the current provider' },
  { name: '/provider', description: 'switch provider' },
  { name: '/system', description: 'view, set, or clear the system prompt' },
  { name: '/tools', description: 'toggle tool-calling, or list tools' },
  { name: '/save', description: 'save the conversation' },
  { name: '/load', description: 'load a saved conversation' },
  { name: '/copy', description: "copy the assistant's last reply" },
  { name: '/skill', description: 'save, use, list or migrate skills' },
  { name: '/personality', description: 'show, reload, or drop the active personality' },
  { name: '/memory', description: 'list, show, or forget stored memories' },
  { name: '/session', description: 'open, switch between, or close sessions' },
  { name: '/workflow', description: 'run a plan/build/test/validate pipeline' },
  { name: '/random', description: 'switch to a random provider and model' },
  { name: '/usage', description: 'show OpenRouter spend' },
  { name: '/recall', description: 'search past conversations' },
  { name: '/history', description: 'show or clear stored input history' },
  { name: '/clear', description: 'reset the conversation' },
  { name: '/exit', description: 'quit' },
];

/** Commands whose name starts with `buffer` — empty (no popup) unless `buffer` is a slash command in progress. */
export function filterSlashCommands(buffer: string, commands: SlashCommandEntry[] = SLASH_COMMANDS): SlashCommandEntry[] {
  if (!buffer.startsWith('/')) return [];
  const lower = buffer.toLowerCase();
  return commands.filter((c) => c.name.startsWith(lower));
}

const NAME_WIDTH = 12;

export interface SlashPromptConfig {
  /** Lines submitted earlier this session, oldest first. Walked with up/down. */
  history?: string[];
  /**
   * Shown before the caret, e.g. `2` for session two. Omitted entirely when
   * only one session is open, so a user who never touches /session sees no
   * change to the prompt they already know.
   */
  promptPrefix?: string;
}

/**
 * What node's readline actually emits on a keypress.
 *
 * @inquirer/core's own KeypressEvent narrows this to the fields it needs, so
 * `meta` (the Alt modifier) and `sequence` (the literal characters typed) are
 * absent from it — both of which this prompt depends on.
 */
interface FullKeypress {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export const promptWithSlashMenu = createPrompt<string, SlashPromptConfig>((config, done) => {
  const history = config.history ?? [];
  // LineBuffer mutates in place, so `version` exists purely to force a
  // re-render after a mutation.
  const [buffer] = useState(() => new LineBuffer());
  const [version, setVersion] = useState(0);
  const [matches, setMatches] = useState<SlashCommandEntry[]>([]);
  const [selected, setSelected] = useState(0);
  // `history.length` means "the present" — the line being typed, one past the
  // newest entry. Anything lower indexes into history.
  const [cursor, setCursor] = useState(history.length);
  const [draft, setDraft] = useState('');

  useKeypress((rawKey, rl) => {
    const key = rawKey as FullKeypress;
    // readline keeps its own buffer, which we do not use. Clearing it every
    // keypress stops it echoing a second, single-line copy of the input.
    rl.clearLine(0);
    const redraw = () => setVersion(version + 1);

    // Replaces the buffer without re-running the slash filter. Recalling a
    // command like "/random" must NOT reopen the popup: if it did, the next
    // `up` would move the popup selection instead of continuing back through
    // history, and recall would jam after a single step.
    const replaceBuffer = (text: string) => {
      buffer.setText(text);
      setMatches([]);
      setSelected(0);
      redraw();
    };

    if (key.name === 'up' && matches.length > 0) {
      setSelected((selected - 1 + matches.length) % matches.length);
      return;
    }
    if (key.name === 'down' && matches.length > 0) {
      setSelected((selected + 1) % matches.length);
      return;
    }

    // Alt+Enter inserts a newline. `key.meta` is how the terminal reports Alt;
    // Shift+Enter is indistinguishable from Enter on many terminals, which is
    // why Alt is the documented binding.
    if (isEnterKey(rawKey) && key.meta) {
      buffer.newline();
      redraw();
      return;
    }
    // A trailing backslash continues the line, for terminals that swallow
    // Alt+Enter entirely.
    if (isEnterKey(rawKey) && buffer.text.endsWith('\\')) {
      buffer.backspace();
      buffer.newline();
      redraw();
      return;
    }
    if (isEnterKey(rawKey)) {
      // readline.Interface always treats Enter as "submit and clear the
      // buffer" internally, independent of anything this hook does — so Enter
      // must always resolve the prompt here rather than trying to special-case
      // "select without submitting" (that fights readline's own built-in
      // handling and produces a garbled second render). If a popup is open,
      // submit the highlighted command directly.
      done(matches.length > 0 ? matches[selected].name : buffer.text);
      return;
    }

    // Up/down move within a multiline buffer first, and only reach into
    // history from the first or last line. Otherwise editing line two of a
    // paragraph would silently replace the whole thing with a history entry.
    if (key.name === 'up') {
      if (!buffer.atFirstLine) {
        buffer.moveUp();
        redraw();
        return;
      }
      if (history.length === 0) return;
      // Stash what's being typed the moment we leave the present, so `down`
      // can hand it back.
      if (cursor === history.length) setDraft(buffer.text);
      const next = Math.max(cursor - 1, 0);
      setCursor(next);
      replaceBuffer(history[next]);
      return;
    }
    if (key.name === 'down') {
      if (!buffer.atLastLine) {
        buffer.moveDown();
        redraw();
        return;
      }
      if (cursor >= history.length) return;
      const next = cursor + 1;
      setCursor(next);
      replaceBuffer(next === history.length ? draft : history[next]);
      return;
    }

    if (key.name === 'tab' && matches.length > 0) {
      // Shell-style completion: fills the highlighted command in and closes
      // the popup, but does NOT submit — lets commands that take an argument
      // (e.g. "/skill save <name>") have one typed before Enter is pressed.
      buffer.setText(`${matches[selected].name} `);
      setMatches([]);
      setSelected(0);
      redraw();
      return;
    }
    if (key.name === 'escape' && matches.length > 0) {
      setMatches([]);
      return;
    }
    if (key.name === 'left') {
      buffer.moveLeft();
      redraw();
      return;
    }
    if (key.name === 'right') {
      buffer.moveRight();
      redraw();
      return;
    }
    if (key.name === 'backspace') {
      buffer.backspace();
    } else if (key.sequence && !key.ctrl && !key.meta && key.sequence >= ' ') {
      buffer.insert(key.sequence);
    } else {
      return;
    }

    // Keep the stash in sync while the cursor is at the present, so typing a
    // draft then walking up and back down restores what was actually typed.
    if (cursor === history.length) setDraft(buffer.text);
    // The slash filter reads the first line only — a command is never spread
    // across lines.
    setMatches(filterSlashCommands(buffer.lines[0]));
    setSelected(0);
    redraw();
  });

  // Continuation lines indent by two, so they align under the "> " prefix.
  // Continuation lines indent to match the caret, so a multiline message stays
  // aligned whether or not a session number is shown.
  const caret = config.promptPrefix ? `${config.promptPrefix}> ` : '> ';
  const indent = ' '.repeat(caret.length);
  const rendered = buffer.lines
    .map((line, i) => (i === 0 ? `${USER_INPUT_COLOR}${caret}${line}` : `${indent}${line}`))
    .join('\n');
  const top = `${rendered}${RESET_COLOR}`;
  const bottom =
    matches.length > 0
      ? matches
          .map((entry, i) => {
            const line = `  ${entry.name.padEnd(NAME_WIDTH)} ${entry.description}`;
            return i === selected ? assistantColor(line) : mutedColor(line);
          })
          .join('\n')
      : undefined;

  return [top, bottom];
});

/** Same contract as readline's rl.question(): resolves with the submitted line. Shows a live-filtered slash-command popup while the buffer starts with "/", and walks `history` with the up/down arrows. */
export function readSlashAwareLine(history: string[] = [], promptPrefix?: string): Promise<string> {
  return promptWithSlashMenu({ history, promptPrefix });
}
