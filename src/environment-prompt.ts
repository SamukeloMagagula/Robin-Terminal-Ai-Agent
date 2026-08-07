import os from 'node:os';

const SHELLS: Record<string, string> = {
  win32: 'cmd.exe',
  darwin: '/bin/sh',
};

function shellName(): string {
  return SHELLS[process.platform] ?? '/bin/sh';
}

function platformName(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

/**
 * Always prepended to whatever system prompt is active. Without it the model
 * has no idea which platform it is on and will happily suggest commands that
 * do not exist here.
 */
export function environmentPrompt(cwd: string = process.cwd()): string {
  return [
    `You are running on ${platformName()} (${process.platform}, ${os.release()}).`,
    `The run_command tool executes via ${shellName()}, not bash.`,
    `Working directory: ${cwd}`,
    '',
    'Prefer commands available on this platform. Do not suggest commands from',
    'other operating systems.',
  ].join('\n');
}
