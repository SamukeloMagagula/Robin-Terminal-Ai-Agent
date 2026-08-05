import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/repl/parse-command';

describe('parseCommand', () => {
  it('parses /help', () => {
    expect(parseCommand('/help')).toEqual({ type: 'help' });
  });

  it('parses /exit', () => {
    expect(parseCommand('/exit')).toEqual({ type: 'exit' });
  });

  it('parses /clear', () => {
    expect(parseCommand('/clear')).toEqual({ type: 'clear' });
  });

  it('parses /model', () => {
    expect(parseCommand('/model')).toEqual({ type: 'model' });
  });

  it('parses /provider', () => {
    expect(parseCommand('/provider')).toEqual({ type: 'provider' });
  });

  it('treats anything else as a message, trimmed', () => {
    expect(parseCommand('  hello there  ')).toEqual({ type: 'message', arg: 'hello there' });
  });

  it('treats an unknown slash command as a literal message', () => {
    expect(parseCommand('/bogus')).toEqual({ type: 'message', arg: '/bogus' });
  });
});
