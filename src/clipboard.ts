import { spawn } from 'node:child_process';

export interface ClipboardCommand {
  cmd: string;
  args: string[];
}

export function clipboardCommandFor(platform: NodeJS.Platform): ClipboardCommand {
  if (platform === 'win32') return { cmd: 'clip', args: [] };
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] };
  return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
}

export function copyToClipboard(text: string): Promise<void> {
  const { cmd, args } = clipboardCommandFor(process.platform);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"${cmd}" exited with code ${code}`));
    });
    child.stdin.end(text);
  });
}
