import { describe, it, expect } from 'vitest';
import { parseBackendFlag } from '../../src/commands/backend-flag';

describe('parseBackendFlag', () => {
  it('parses "docker:<image>" into a docker backend config', () => {
    expect(parseBackendFlag('docker:node:20')).toEqual({ kind: 'docker', image: 'node:20' });
  });

  it('parses a simple image name with no tag', () => {
    expect(parseBackendFlag('docker:alpine')).toEqual({ kind: 'docker', image: 'alpine' });
  });

  it('refuses "docker" with no image, naming the fix', () => {
    expect(() => parseBackendFlag('docker')).toThrow(/image/i);
  });

  it('refuses "docker:" with an empty image', () => {
    expect(() => parseBackendFlag('docker:')).toThrow(/image/i);
  });

  it('refuses an unrecognized backend kind rather than silently falling back to local', () => {
    expect(() => parseBackendFlag('modal:something')).toThrow(/modal/i);
  });

  it('refuses a bare unrecognized string', () => {
    expect(() => parseBackendFlag('nonsense')).toThrow(/nonsense/i);
  });
});
