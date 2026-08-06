import { spawn } from 'node:child_process';

/**
 * True when a graphical browser is plausibly launchable: always on
 * Windows/macOS, and on Linux only when a display server is present (so a
 * headless SSH/PuTTY session correctly reports false rather than spawning a
 * doomed browser command).
 */
export function canOpenGraphicalBrowser(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'win32' || platform === 'darwin') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Best-effort: opens `url` in Chrome. Returns false (without throwing) if no graphical browser is available. */
export function openBrowser(url: string): boolean {
  if (!canOpenGraphicalBrowser(process.platform, process.env)) return false;
  try {
    if (process.platform === 'win32') {
      // "start chrome <url>" resolves via the Windows "App Paths" registry
      // entry Chrome's installer registers, so it works even when chrome.exe
      // isn't on PATH. Empty "" is the window-title arg start expects.
      spawn('cmd', ['/c', 'start', '""', 'chrome', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('google-chrome', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** Prints `url` and either opens Chrome or explains why it can't, so the message always makes sense. */
export function announceAndOpen(url: string): void {
  console.log(`Go to ${url}`);
  if (openBrowser(url)) {
    console.log('Opening Chrome...');
  } else {
    console.log('No graphical browser detected here (e.g. an SSH/PuTTY session) — open the link above on a device with a browser.');
  }
}
