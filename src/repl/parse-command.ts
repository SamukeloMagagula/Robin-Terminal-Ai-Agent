export interface ParsedCommand {
  type:
    | 'help'
    | 'exit'
    | 'clear'
    | 'model'
    | 'provider'
    | 'system'
    | 'save'
    | 'load'
    | 'tools'
    | 'copy'
    | 'skill'
    | 'recall'
    | 'message'
    | 'unknown';
  arg?: string;
}

const KNOWN_COMMANDS: Record<string, ParsedCommand['type']> = {
  '/': 'help',
  '/help': 'help',
  '/exit': 'exit',
  '/clear': 'clear',
  '/model': 'model',
  '/provider': 'provider',
  '/system': 'system',
  '/save': 'save',
  '/load': 'load',
  '/tools': 'tools',
  '/copy': 'copy',
  '/skill': 'skill',
  '/recall': 'recall',
};

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { type: 'message', arg: trimmed };

  const spaceIndex = trimmed.indexOf(' ');
  const commandWord = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const arg = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim() || undefined;

  const known = KNOWN_COMMANDS[commandWord];
  if (known) return { type: known, arg };
  return { type: 'unknown', arg: commandWord };
}
