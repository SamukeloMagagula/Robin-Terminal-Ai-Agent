import { describe, it, expect } from 'vitest';
import { canOpenGraphicalBrowser } from '../src/browser';

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
