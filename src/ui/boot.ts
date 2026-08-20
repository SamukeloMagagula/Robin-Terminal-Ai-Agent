import { mutedColor, errorColor } from './theme.js';

/**
 * Visible progress through the real sequential work that happens between
 * model selection and the prompt appearing — starting the gateway, opening a
 * session, loading memory/skills/tools. Nothing here is decorative: every
 * step wraps work that was already running, invisibly, before this existed.
 * A step that resolves in a few milliseconds just flashes by as a quick
 * checkmark, which is honest about how fast it actually was rather than
 * padded with an artificial delay to look substantial.
 */
export interface BootStepIO {
  write: (chunk: string) => void;
  /** Whether the line can be rewritten in place. Piped output cannot. */
  isTTY?: boolean;
}

function defaultIO(): BootStepIO {
  return { write: (chunk) => process.stdout.write(chunk), isTTY: process.stdout.isTTY };
}

export async function runBootStep<T>(
  label: string,
  work: () => Promise<T>,
  io: BootStepIO = defaultIO()
): Promise<T> {
  if (io.isTTY) io.write(`  ⏳ ${label}`);

  try {
    const result = await work();
    io.write(io.isTTY ? `\r\x1b[K  ${mutedColor('✓')} ${label}\n` : `  ${mutedColor('✓')} ${label}\n`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.write(
      io.isTTY
        ? `\r\x1b[K  ${errorColor('✗')} ${label} — ${message}\n`
        : `  ${errorColor('✗')} ${label} — ${message}\n`
    );
    throw err;
  }
}
