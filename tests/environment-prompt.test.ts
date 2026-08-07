import { describe, it, expect } from 'vitest';
import { environmentPrompt } from '../src/environment-prompt';

describe('environmentPrompt', () => {
  it('names the current platform', () => {
    const expected = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[
      process.platform as string
    ];
    if (expected) expect(environmentPrompt()).toContain(expected);
    expect(environmentPrompt()).toContain(process.platform);
  });

  it('names the shell run_command uses', () => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    expect(environmentPrompt()).toContain(shell);
  });

  it('includes the working directory it is given', () => {
    expect(environmentPrompt('/some/where')).toContain('Working directory: /some/where');
  });

  it('defaults the working directory to process.cwd()', () => {
    expect(environmentPrompt()).toContain(process.cwd());
  });

  it('tells the model not to suggest other platforms commands', () => {
    expect(environmentPrompt()).toContain('other operating systems');
  });
});
