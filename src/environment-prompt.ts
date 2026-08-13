import os from 'node:os';

const SHELLS: Record<string, string> = {
  win32: 'cmd.exe',
  darwin: '/bin/sh',
};

function shellName(): string {
  return SHELLS[process.platform] ?? '/bin/sh';
}

/** Exported so the HUD shows the same platform name the model is told. */
export function platformName(): string {
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
    '',
    // Without this, a general-knowledge question gets treated as a research
    // task about the working directory: an exam-difficulty question once sent
    // a model through dir, find, grep and a proposal to look the exam up in a
    // materials database. Tools act on this machine; they are not a search
    // engine, and most questions are not about the files in front of you.
    'The tools act on this machine. Use them only when the answer depends on',
    'something here — a file, the state of the system, the result of running',
    'something. Answer general questions from your own knowledge, directly. If',
    'you do not know, say so; searching the working directory will not help.',
    '',
    'If the user declines a command or a file write, do not retry it in another',
    'form. Take the decline as an answer and continue without it.',
  ].join('\n');
}
