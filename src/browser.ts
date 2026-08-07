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

/**
 * Only http(s) URLs are ever handed to a shell. The URLs here come from
 * provider responses (OAuth verification URIs), so they are not under our
 * control, and cmd.exe re-parses its arguments — an embedded `&` or `|` in a
 * hostile URL would otherwise run as a separate command.
 */
export function isSafeBrowserUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !/[&|^<>"'`\r\n\s]/.test(url);
}

/**
 * Best-effort: opens `url` in a browser. Returns false (without throwing) when
 * the URL is unsafe or no graphical browser is available.
 */
export function openBrowser(url: string): boolean {
  if (!isSafeBrowserUrl(url)) return false;
  if (!canOpenGraphicalBrowser(process.platform, process.env)) return false;
  try {
    if (process.platform === 'win32') {
      // Hands the URL to the default browser without a shell. The previous
      // "cmd /c start ... chrome" spawned cmd.exe, which re-parses its own
      // command line, so any shell metacharacter in the URL would have run as
      // a separate command.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        stdio: 'ignore',
        detached: true,
      }).unref();
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

/** Prints `url` and either opens a browser or explains why it can't, so the message always makes sense. */
export function announceAndOpen(url: string): void {
  console.log(`Go to ${url}`);
  if (openBrowser(url)) {
    console.log('Opening your browser...');
  } else {
    console.log('No graphical browser detected here (e.g. an SSH/PuTTY session) — open the link above on a device with a browser.');
  }
}
