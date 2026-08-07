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
  { name: '/random', description: 'switch to a random provider and model' },
  { name: '/recall', description: 'search past conversations' },
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

export const promptWithSlashMenu = createPrompt<string, Record<string, never>>((_config, done) => {
  const [value, setValue] = useState('');
  const [matches, setMatches] = useState<SlashCommandEntry[]>([]);
  const [selected, setSelected] = useState(0);

  useKeypress((key, rl) => {
    if (key.name === 'up' && matches.length > 0) {
      setSelected((selected - 1 + matches.length) % matches.length);
      return;
    }
    if (key.name === 'down' && matches.length > 0) {
      setSelected((selected + 1) % matches.length);
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

/** Same contract as readline's rl.question(): resolves with the submitted line. Shows a live-filtered slash-command popup while the buffer starts with "/". */
export function readSlashAwareLine(): Promise<string> {
  return promptWithSlashMenu({});
}
