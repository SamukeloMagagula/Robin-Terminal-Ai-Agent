/**
 * Screenshots, via each OS's own tool rather than a native npm dependency.
 *
 * No native package (and the C++ toolchain risk one brings — better-sqlite3
 * in this very repo already needs one on some machines). Every platform
 * writes to a random temp file and this reads it back, rather than piping
 * image bytes through stdout — one code path instead of three different
 * streaming conventions.
 *
 * Always runs on the host directly via LocalBackend, bypassing whatever
 * ExecutionBackend a session is configured with: a screenshot means "what's
 * on *my* screen," not wherever run_command would execute.
 */

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { LocalBackend } from '../backends/local.js';
import type { Media } from './client.js';

const CAPTURE_TIMEOUT_MS = 10_000;

interface Runner {
  runArgv(
    args: [string, ...string[]],
    options: { cwd: string; timeoutMs: number }
  ): Promise<{
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    spawnError?: string;
  }>;
}

interface LinuxTool {
  command: string;
  args: (tempPath: string) => string[];
}

/** Probed in order with `which`; the first one present is used. */
const LINUX_TOOLS: LinuxTool[] = [
  { command: 'grim', args: (p) => [p] },
  { command: 'scrot', args: (p) => [p] },
  { command: 'gnome-screenshot', args: (p) => ['-f', p] },
  { command: 'import', args: (p) => ['-window', 'root', p] },
];

/**
 * `System.Windows.Forms` and `System.Drawing` ship with .NET, nothing to
 * install. Single quotes in the path are doubled, PowerShell's own escape
 * for a literal quote inside a single-quoted string.
 */
function powershellScript(tempPath: string): string {
  const escaped = tempPath.replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
}

async function run(runner: Runner, args: [string, ...string[]]): Promise<void> {
  const result = await runner.runArgv(args, { cwd: process.cwd(), timeoutMs: CAPTURE_TIMEOUT_MS });
  if (result.spawnError !== undefined) {
    throw new Error(`Could not run ${args[0]}: ${result.spawnError}`);
  }
  if (result.timedOut) {
    throw new Error(`${args[0]} timed out after ${CAPTURE_TIMEOUT_MS}ms.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${args[0]} exited with code ${result.exitCode}: ${result.output.trim()}`);
  }
}

async function findLinuxTool(runner: Runner): Promise<LinuxTool | undefined> {
  for (const tool of LINUX_TOOLS) {
    const result = await runner.runArgv(['which', tool.command], {
      cwd: process.cwd(),
      timeoutMs: CAPTURE_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return tool;
  }
  return undefined;
}

export async function captureScreen(runner: Runner = new LocalBackend()): Promise<Media> {
  const tempPath = path.join(os.tmpdir(), `robin-screen-${randomUUID()}.png`);

  if (process.platform === 'win32') {
    await run(runner, ['powershell', '-NoProfile', '-Command', powershellScript(tempPath)]);
  } else if (process.platform === 'darwin') {
    await run(runner, ['screencapture', '-x', '-t', 'png', tempPath]);
  } else if (process.platform === 'linux') {
    const tool = await findLinuxTool(runner);
    if (!tool) {
      throw new Error(
        'No screenshot tool found. Install one of: grim, scrot, gnome-screenshot, or ImageMagick (import).'
      );
    }
    await run(runner, [tool.command, ...tool.args(tempPath)] as [string, ...string[]]);
  } else {
    throw new Error(`Screen capture is not supported on this platform (${process.platform}).`);
  }

  try {
    const data = await fs.readFile(tempPath);
    return { data, mimeType: 'image/png' };
  } finally {
    await fs.unlink(tempPath).catch(() => {
      // Best-effort: the capture already succeeded either way.
    });
  }
}
