import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { captureScreen } from '../../src/media/screen-capture';

interface FakeRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

function ok(): FakeRunResult {
  return { exitCode: 0, output: '', timedOut: false };
}

function fail(exitCode: number, output = 'boom'): FakeRunResult {
  return { exitCode, output, timedOut: false };
}

/** Extracts the destination path a capture command was told to write to. */
function extractPath(args: string[]): string {
  // Windows: `$bmp.Save('C:\...\foo.png', ...)` inside the -Command string.
  const psMatch = args.find((a) => a.includes('.Save('));
  if (psMatch) {
    const match = /\.Save\('([^']+)'/.exec(psMatch);
    if (match) return match[1];
  }
  // Every other tool's temp path is simply its last argument.
  return args[args.length - 1];
}

const DUMMY_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let platformSpy: ReturnType<typeof vi.spyOn> | undefined;

function setPlatform(platform: string): void {
  platformSpy?.mockRestore();
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
}

afterEach(() => {
  platformSpy?.mockRestore();
  platformSpy = undefined;
});

describe('captureScreen — win32', () => {
  it('runs a PowerShell script that saves to the temp path, and returns its bytes', async () => {
    setPlatform('win32');
    const calls: string[][] = [];
    const runner = {
      runArgv: vi.fn().mockImplementation(async (args: string[]) => {
        calls.push(args);
        await fs.writeFile(extractPath(args), DUMMY_PNG);
        return ok();
      }),
    };

    const media = await captureScreen(runner);

    expect(calls[0][0]).toBe('powershell');
    expect(calls[0]).toContain('-NoProfile');
    expect(calls[0].join(' ')).toContain('CopyFromScreen');
    expect(media).toEqual({ data: DUMMY_PNG, mimeType: 'image/png' });
  });

  it('deletes the temp file after reading it', async () => {
    setPlatform('win32');
    let capturedPath = '';
    const runner = {
      runArgv: vi.fn().mockImplementation(async (args: string[]) => {
        capturedPath = extractPath(args);
        await fs.writeFile(capturedPath, DUMMY_PNG);
        return ok();
      }),
    };

    await captureScreen(runner);

    await expect(fs.access(capturedPath)).rejects.toThrow();
  });
});

describe('captureScreen — darwin', () => {
  it('runs screencapture with the temp path and returns its bytes', async () => {
    setPlatform('darwin');
    const calls: string[][] = [];
    const runner = {
      runArgv: vi.fn().mockImplementation(async (args: string[]) => {
        calls.push(args);
        await fs.writeFile(extractPath(args), DUMMY_PNG);
        return ok();
      }),
    };

    const media = await captureScreen(runner);

    expect(calls[0]).toEqual(['screencapture', '-x', '-t', 'png', expect.any(String)]);
    expect(media).toEqual({ data: DUMMY_PNG, mimeType: 'image/png' });
  });
});

describe('captureScreen — linux', () => {
  it('uses the first available tool, probing with `which` in order', async () => {
    setPlatform('linux');
    const calls: string[][] = [];
    const runner = {
      runArgv: vi.fn().mockImplementation(async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'which') {
          // grim and scrot absent, gnome-screenshot present.
          return args[1] === 'gnome-screenshot' ? ok() : fail(1, 'not found');
        }
        await fs.writeFile(extractPath(args), DUMMY_PNG);
        return ok();
      }),
    };

    const media = await captureScreen(runner);

    expect(calls.map((c) => c[0])).toEqual(['which', 'which', 'which', 'gnome-screenshot']);
    expect(calls[3]).toEqual(['gnome-screenshot', '-f', expect.any(String)]);
    expect(media).toEqual({ data: DUMMY_PNG, mimeType: 'image/png' });
  });

  it('throws naming every known tool when none is found', async () => {
    setPlatform('linux');
    const runner = { runArgv: vi.fn().mockResolvedValue(fail(1, 'not found')) };

    await expect(captureScreen(runner)).rejects.toThrow(
      /grim.*scrot.*gnome-screenshot.*import/s
    );
  });
});

describe('captureScreen — failure paths', () => {
  it('throws with the spawn error when the tool cannot be run at all', async () => {
    setPlatform('darwin');
    const runner = {
      runArgv: vi.fn().mockResolvedValue({ exitCode: null, output: '', timedOut: false, spawnError: 'ENOENT' }),
    };

    await expect(captureScreen(runner)).rejects.toThrow(/ENOENT/);
  });

  it('throws when the capture times out', async () => {
    setPlatform('darwin');
    const runner = {
      runArgv: vi.fn().mockResolvedValue({ exitCode: null, output: '', timedOut: true }),
    };

    await expect(captureScreen(runner)).rejects.toThrow(/timed out/);
  });

  it('throws with the process output on a non-zero exit', async () => {
    setPlatform('darwin');
    const runner = { runArgv: vi.fn().mockResolvedValue(fail(1, 'permission denied')) };

    await expect(captureScreen(runner)).rejects.toThrow(/permission denied/);
  });

  it('throws for an unsupported platform', async () => {
    setPlatform('freebsd');
    const runner = { runArgv: vi.fn() };

    await expect(captureScreen(runner)).rejects.toThrow(/not supported/);
    expect(runner.runArgv).not.toHaveBeenCalled();
  });
});
