import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

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
 * Only http(s) URLs are ever handed to a browser. The URLs here come from
 * provider responses (OAuth verification URIs), so they are not under our
 * control. Nothing below spawns a shell, but the check is kept because a URL
 * beginning with `-` would otherwise be read by chrome.exe as a flag rather
 * than an address.
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
 * Where Chrome installs itself on Windows. Per-user installs land in
 * LOCALAPPDATA and are the common case on a locked-down corporate machine
 * where the user cannot write to Program Files, so that path is tried first.
 */
function windowsChromeCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.LOCALAPPDATA,
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.PROGRAMW6432,
  ].filter((root): root is string => Boolean(root));

  return roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
}

/**
 * The Chrome executable to launch, or null when Chrome is not installed here.
 *
 * ROBIN_BROWSER wins over everything: it is how someone points Robin at a
 * Chrome in a non-standard location, or deliberately at a different browser.
 * Exported for the tests, which must not depend on what is installed on the
 * machine running them.
 */
export function resolveChromePath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync
): string | null {
  const override = env.ROBIN_BROWSER?.trim();
  if (override) return override;
  if (platform !== 'win32') return null;
  return windowsChromeCandidates(env).find((candidate) => exists(candidate)) ?? null;
}

/**
 * Best-effort: opens `url` in Google Chrome. Returns false (without throwing)
 * when the URL is unsafe or no graphical browser is available.
 *
 * Chrome is named explicitly on every platform rather than deferring to the
 * OS default handler. Robin's login flows are Chrome-shaped — the user's
 * provider sessions and passkeys live in their Chrome profile — so handing an
 * OAuth URL to whatever Windows has registered (Edge, on a default corporate
 * image) drops them into a browser where they are not signed in.
 */
export function openBrowser(url: string): boolean {
  if (!isSafeBrowserUrl(url)) return false;
  if (!canOpenGraphicalBrowser(process.platform, process.env)) return false;
  try {
    if (process.platform === 'win32') {
      const chrome = resolveChromePath(process.platform, process.env);
      if (chrome) {
        // Spawned directly, with no shell: the URL is a single argv element,
        // so shell metacharacters in it are inert. The previous
        // `cmd /c start` form re-parsed its own command line, and the
        // rundll32 form that replaced it went to the default browser.
        spawn(chrome, [url], { stdio: 'ignore', detached: true }).unref();
      } else {
        // Chrome is genuinely not installed — the default handler beats no
        // browser at all.
        spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
          stdio: 'ignore',
          detached: true,
        }).unref();
      }
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      const linuxChrome = process.env.ROBIN_BROWSER?.trim() || 'google-chrome';
      spawn(linuxChrome, [url], { stdio: 'ignore', detached: true }).unref();
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
    console.log('Opening Chrome...');
  } else {
    console.log('No graphical browser detected here (e.g. an SSH/PuTTY session) — open the link above on a device with a browser.');
  }
}
