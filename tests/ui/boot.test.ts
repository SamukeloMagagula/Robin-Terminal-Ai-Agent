import { describe, it, expect, vi } from 'vitest';
import { runBootStep } from '../../src/ui/boot';

function collector() {
  const chunks: string[] = [];
  return { write: (s: string) => chunks.push(s), chunks };
}

describe('runBootStep — TTY', () => {
  it('prints a pending line then overwrites it with a checkmark on success', async () => {
    const { write, chunks } = collector();
    const result = await runBootStep('Starting gateway', async () => 42, { write, isTTY: true });

    expect(result).toBe(42);
    const output = chunks.join('');
    expect(output).toContain('Starting gateway');
    expect(output).toContain('✓');
    // The rewrite uses a carriage return, not a second full line.
    expect(output).toContain('\r');
  });

  it('overwrites the pending line with an X and the error message on failure', async () => {
    const { write, chunks } = collector();
    const boom = new Error('connection refused');

    await expect(
      runBootStep(
        'Starting gateway',
        async () => {
          throw boom;
        },
        { write, isTTY: true }
      )
    ).rejects.toThrow('connection refused');

    const output = chunks.join('');
    expect(output).toContain('✗');
    expect(output).toContain('connection refused');
  });

  it('rethrows the original error, unwrapped', async () => {
    const { write } = collector();
    const boom = new Error('boom');

    await expect(
      runBootStep(
        'x',
        async () => {
          throw boom;
        },
        { write, isTTY: true }
      )
    ).rejects.toBe(boom);
  });
});

describe('runBootStep — non-TTY', () => {
  it('prints one plain done line, no cursor control', async () => {
    const { write, chunks } = collector();
    await runBootStep('Starting gateway', async () => undefined, { write, isTTY: false });

    const output = chunks.join('');
    expect(output).toContain('Starting gateway');
    expect(output).toContain('✓');
    expect(output).not.toContain('\r');
    // Exactly one write call — no separate pending line for a non-interactive stream.
    expect(chunks.length).toBe(1);
  });

  it('prints one plain failure line and rethrows', async () => {
    const { write, chunks } = collector();
    await expect(
      runBootStep(
        'Starting gateway',
        async () => {
          throw new Error('nope');
        },
        { write, isTTY: false }
      )
    ).rejects.toThrow('nope');

    const output = chunks.join('');
    expect(output).toContain('✗');
    expect(output).toContain('nope');
  });
});

describe('runBootStep — default io', () => {
  it('falls back to process.stdout when no io is given', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await runBootStep('x', async () => 'done');
      expect(result).toBe('done');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
