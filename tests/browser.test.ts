import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { canOpenGraphicalBrowser, isSafeBrowserUrl, resolveChromePath } from '../src/browser';

const never = () => false;
const always = () => true;

describe('canOpenGraphicalBrowser', () => {
  it('is always true on win32', () => {
    expect(canOpenGraphicalBrowser('win32', {})).toBe(true);
  });

  it('is always true on darwin', () => {
    expect(canOpenGraphicalBrowser('darwin', {})).toBe(true);
  });

  it('is false on linux with no display server (headless SSH/PuTTY)', () => {
    expect(canOpenGraphicalBrowser('linux', {})).toBe(false);
  });

  it('is true on linux when DISPLAY is set (X11)', () => {
    expect(canOpenGraphicalBrowser('linux', { DISPLAY: ':0' })).toBe(true);
  });

  it('is true on linux when WAYLAND_DISPLAY is set', () => {
    expect(canOpenGraphicalBrowser('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });
});

describe('resolveChromePath', () => {
  it('finds a per-user Chrome install under LOCALAPPDATA', () => {
    const expected = path.join('C:\\Users\\me\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
    const resolved = resolveChromePath(
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      (p) => p === expected
    );
    expect(resolved).toBe(expected);
  });

  it('finds a machine-wide Chrome install under Program Files', () => {
    const expected = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
    const resolved = resolveChromePath(
      'win32',
      { PROGRAMFILES: 'C:\\Program Files' },
      (p) => p === expected
    );
    expect(resolved).toBe(expected);
  });

  it('prefers the per-user install when both are present', () => {
    const resolved = resolveChromePath(
      'win32',
      { LOCALAPPDATA: 'C:\\local', PROGRAMFILES: 'C:\\Program Files' },
      always
    );
    expect(resolved).toBe(path.join('C:\\local', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  });

  it('returns null when Chrome is not installed, so the caller can fall back', () => {
    expect(resolveChromePath('win32', { PROGRAMFILES: 'C:\\Program Files' }, never)).toBeNull();
  });

  it('lets ROBIN_BROWSER override the search entirely', () => {
    expect(resolveChromePath('win32', { ROBIN_BROWSER: 'D:\\chrome.exe' }, never)).toBe('D:\\chrome.exe');
  });

  it('honours ROBIN_BROWSER off Windows too', () => {
    expect(resolveChromePath('linux', { ROBIN_BROWSER: '/usr/bin/chromium' }, never)).toBe(
      '/usr/bin/chromium'
    );
  });

  it('ignores a blank ROBIN_BROWSER rather than trying to spawn an empty command', () => {
    expect(resolveChromePath('win32', { ROBIN_BROWSER: '   ' }, never)).toBeNull();
  });
});

describe('isSafeBrowserUrl', () => {
  it('accepts an ordinary https OAuth URL', () => {
    expect(isSafeBrowserUrl('https://github.com/login/device?code=ABCD-1234')).toBe(true);
  });

  it('rejects a non-http scheme', () => {
    expect(isSafeBrowserUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
  });

  it('rejects a URL carrying shell metacharacters', () => {
    expect(isSafeBrowserUrl('https://example.com/?a=1&whoami')).toBe(false);
  });

  it('rejects a value that is not a URL at all', () => {
    expect(isSafeBrowserUrl('not a url')).toBe(false);
  });
});
