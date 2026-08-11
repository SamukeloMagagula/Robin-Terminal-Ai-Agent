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
    | 'random'
    | 'usage'
    | 'recall'
    | 'history'
    | 'personality'
    | 'memory'
    | 'message'
    | 'unknown';
  arg?: string;
}

// Null-prototype: a plain object literal would make "/toString", "/constructor"
// and "/__proto__" resolve to inherited Object members and read as known
// commands, so they were silently swallowed instead of reported as unknown.
const KNOWN_COMMANDS: Record<string, ParsedCommand['type']> = Object.assign(Object.create(null), {
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
  '/random': 'random',
  '/usage': 'usage',
  '/recall': 'recall',
  '/history': 'history',
  '/personality': 'personality',
  '/memory': 'memory',
});

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
