import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/repl/parse-command';

describe('parseCommand', () => {
  it('parses /help', () => {
    expect(parseCommand('/help')).toEqual({ type: 'help' });
  });

  it('parses a bare "/" as help, same as /help', () => {
    expect(parseCommand('/')).toEqual({ type: 'help' });
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

  it('treats an unrecognized slash command as unknown, not as a message to send', () => {
    expect(parseCommand('/bogus')).toEqual({ type: 'unknown', arg: '/bogus' });
  });

  it('reports only the command word for an unknown command with extra text', () => {
    expect(parseCommand('/modal something else')).toEqual({ type: 'unknown', arg: '/modal' });
  });

  it('parses /system with no argument', () => {
    expect(parseCommand('/system')).toEqual({ type: 'system' });
  });

  it('parses /system with a prompt argument', () => {
    expect(parseCommand('/system you are terse')).toEqual({ type: 'system', arg: 'you are terse' });
  });

  it('parses /system clear', () => {
    expect(parseCommand('/system clear')).toEqual({ type: 'system', arg: 'clear' });
  });

  it('parses /save with a name argument', () => {
    expect(parseCommand('/save my-chat')).toEqual({ type: 'save', arg: 'my-chat' });
  });

  it('parses /save with no argument', () => {
    expect(parseCommand('/save')).toEqual({ type: 'save' });
  });

  it('parses /load with a name argument', () => {
    expect(parseCommand('/load my-chat')).toEqual({ type: 'load', arg: 'my-chat' });
  });

  it('parses /tools with no argument', () => {
    expect(parseCommand('/tools')).toEqual({ type: 'tools' });
  });

  it('parses /tools list', () => {
    expect(parseCommand('/tools list')).toEqual({ type: 'tools', arg: 'list' });
  });

  it('parses /copy', () => {
    expect(parseCommand('/copy')).toEqual({ type: 'copy' });
  });

  it('parses /skill with no argument', () => {
    expect(parseCommand('/skill')).toEqual({ type: 'skill' });
  });

  it('parses /skill save <name>', () => {
    expect(parseCommand('/skill save reviewer')).toEqual({ type: 'skill', arg: 'save reviewer' });
  });

  it('parses /skill use <name>', () => {
    expect(parseCommand('/skill use reviewer')).toEqual({ type: 'skill', arg: 'use reviewer' });
  });

  it('parses /skill list', () => {
    expect(parseCommand('/skill list')).toEqual({ type: 'skill', arg: 'list' });
  });

  it('parses /recall with a query', () => {
    expect(parseCommand('/recall capital of France')).toEqual({ type: 'recall', arg: 'capital of France' });
  });

  it('parses /recall with no argument', () => {
    expect(parseCommand('/recall')).toEqual({ type: 'recall' });
  });
});
