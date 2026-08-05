export interface ParsedCommand {
  type: 'help' | 'exit' | 'clear' | 'model' | 'provider' | 'message';
  arg?: string;
}

const KNOWN_COMMANDS: Record<string, ParsedCommand['type']> = {
  '/help': 'help',
  '/exit': 'exit',
  '/clear': 'clear',
  '/model': 'model',
  '/provider': 'provider',
};

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  const known = KNOWN_COMMANDS[trimmed];
  if (known) return { type: known };
  return { type: 'message', arg: trimmed };
}
