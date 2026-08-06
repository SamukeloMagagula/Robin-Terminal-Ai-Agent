import { describe, it, expect } from 'vitest';
import { clipboardCommandFor } from '../src/clipboard';

describe('clipboardCommandFor', () => {
  it('uses clip on win32', () => {
    expect(clipboardCommandFor('win32')).toEqual({ cmd: 'clip', args: [] });
  });

  it('uses pbcopy on darwin', () => {
    expect(clipboardCommandFor('darwin')).toEqual({ cmd: 'pbcopy', args: [] });
  });

  it('uses xclip on linux', () => {
    expect(clipboardCommandFor('linux')).toEqual({ cmd: 'xclip', args: ['-selection', 'clipboard'] });
  });
});
