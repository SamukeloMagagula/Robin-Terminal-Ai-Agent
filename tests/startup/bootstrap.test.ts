import { describe, it, expect } from 'vitest';
import {
  isPromptCancellation,
  describeStartupError,
  requireInteractiveTerminal,
  isUserFacing,
  UserFacingError,
} from '../../src/startup/bootstrap';

describe('isPromptCancellation', () => {
  it('recognises inquirer’s Ctrl+C error by name', () => {
    const err = new Error('User force closed the prompt with SIGINT');
    err.name = 'ExitPromptError';
    expect(isPromptCancellation(err)).toBe(true);
  });

  it('recognises it by message when the name has been lost', () => {
    expect(isPromptCancellation(new Error('User force closed the prompt with 0 null'))).toBe(true);
  });

  it('does not mistake an ordinary error for a cancellation', () => {
    expect(isPromptCancellation(new Error('network down'))).toBe(false);
  });

  it('tolerates non-error values', () => {
    expect(isPromptCancellation(undefined)).toBe(false);
    expect(isPromptCancellation('string')).toBe(false);
  });
});

describe('describeStartupError', () => {
  it('turns an ABI mismatch into a rebuild instruction', () => {
    const result = describeStartupError(
      new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 115')
    );
    expect(result.remedy).toContain('npm rebuild better-sqlite3');
  });

  it('turns a missing module into a reinstall instruction', () => {
    const err = Object.assign(new Error('Cannot find module ./dist/cli.js'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(describeStartupError(err).remedy).toContain('npm ci');
  });

  it('explains a permission error', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(describeStartupError(err).remedy).toContain('robin doctor');
  });

  it('explains a network error', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      code: 'ENOTFOUND',
    });
    expect(describeStartupError(err).remedy).toContain('Network');
  });

  it('passes an unrecognised error through with no invented remedy', () => {
    const result = describeStartupError(new Error('something odd'));
    expect(result.message).toBe('something odd');
    expect(result.remedy).toBeUndefined();
  });

  it('handles a thrown non-error', () => {
    expect(describeStartupError('plain string').message).toBe('plain string');
  });

  it('marks a UserFacingError as self-explanatory, so no doctor hint is appended', () => {
    const result = describeStartupError(new UserFacingError('Unknown channel "slack".'));
    expect(result.selfExplanatory).toBe(true);
    expect(result.message).toBe('Unknown channel "slack".');
  });

  it('carries a UserFacingError’s own remedy through', () => {
    const result = describeStartupError(new UserFacingError('No token.', 'Set TELEGRAM_BOT_TOKEN.'));
    expect(result.remedy).toBe('Set TELEGRAM_BOT_TOKEN.');
  });

  it('does not mark an ordinary error as self-explanatory', () => {
    expect(describeStartupError(new Error('odd')).selfExplanatory).toBeUndefined();
  });
});

describe('isUserFacing', () => {
  it('recognises a UserFacingError', () => {
    expect(isUserFacing(new UserFacingError('x'))).toBe(true);
  });

  it('does not recognise an ordinary error or a non-object', () => {
    expect(isUserFacing(new Error('x'))).toBe(false);
    expect(isUserFacing('x')).toBe(false);
    expect(isUserFacing(null)).toBe(false);
  });
});

describe('requireInteractiveTerminal', () => {
  it('passes through when stdin and stdout are a TTY', () => {
    expect(() => requireInteractiveTerminal(true)).not.toThrow();
  });

  it('throws one readable sentence when they are not', () => {
    expect(() => requireInteractiveTerminal(false)).toThrow(/interactive terminal/i);
  });
});
