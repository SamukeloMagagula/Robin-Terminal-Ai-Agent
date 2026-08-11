import { createPrompt, useState, useKeypress, isEnterKey } from '@inquirer/core';
import { USER_INPUT_COLOR, RESET_COLOR, assistantColor, mutedColor } from '../ui/theme.js';

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
  { name: '/skill', description: 'save/use/list system-prompt presets' },
  { name: '/personality', description: 'show, reload, or drop the active personality' },
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
}

export const promptWithSlashMenu = createPrompt<string, SlashPromptConfig>((config, done) => {
  const history = config.history ?? [];
  const [value, setValue] = useState('');
  const [matches, setMatches] = useState<SlashCommandEntry[]>([]);
  const [selected, setSelected] = useState(0);
  // `history.length` means "the present" — the line being typed, one past the
  // newest entry. Anything lower indexes into history.
  const [cursor, setCursor] = useState(history.length);
  const [draft, setDraft] = useState('');

  useKeypress((key, rl) => {
    // Replaces the buffer without re-running the slash filter. Recalling a
    // command like "/random" must NOT reopen the popup: if it did, the next
    // `up` would move the popup selection instead of continuing back through
    // history, and recall would jam after a single step.
    const replaceBuffer = (text: string) => {
      rl.clearLine(0);
      rl.write(text);
      setValue(rl.line);
      setMatches([]);
      setSelected(0);
    };

    if (key.name === 'up' && matches.length > 0) {
      setSelected((selected - 1 + matches.length) % matches.length);
      return;
    }
    if (key.name === 'down' && matches.length > 0) {
      setSelected((selected + 1) % matches.length);
      return;
    }
    if (key.name === 'up') {
      if (history.length === 0) return;
      // Stash what's being typed the moment we leave the present, so `down`
      // can hand it back.
      if (cursor === history.length) setDraft(rl.line);
      const next = Math.max(cursor - 1, 0);
      setCursor(next);
      replaceBuffer(history[next]);
      return;
    }
    if (key.name === 'down') {
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
      const choice = matches[selected];
      rl.clearLine(0);
      rl.write(`${choice.name} `);
      setValue(rl.line);
      setMatches([]);
      setSelected(0);
      return;
    }
    if (key.name === 'escape' && matches.length > 0) {
      setMatches([]);
      return;
    }
    if (isEnterKey(key)) {
      // readline.Interface always treats Enter as "submit and clear the
      // buffer" internally, independent of anything this hook does — so
      // Enter must always resolve the prompt here rather than trying to
      // special-case "select without submitting" (that fights readline's
      // own built-in handling and produces a garbled second render). If a
      // popup is open, submit the highlighted command directly.
      //
      // Submit `value`, NOT rl.line: readline's own Enter handling runs before
      // this listener and has already cleared its buffer, so rl.line is always
      // "" here. `value` is the buffer we mirrored on every other keypress.
      done(matches.length > 0 ? matches[selected].name : value);
      return;
    }
    // Keep the stash in sync while the cursor is at the present, so typing a
    // draft then walking up and back down restores what was actually typed.
    if (cursor === history.length) setDraft(rl.line);
    setValue(rl.line);
    setMatches(filterSlashCommands(rl.line));
    setSelected(0);
  });

  const top = `${USER_INPUT_COLOR}> ${value}${RESET_COLOR}`;
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
export function readSlashAwareLine(history: string[] = []): Promise<string> {
  return promptWithSlashMenu({ history });
}
