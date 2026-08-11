/** Lines the user has submitted at the prompt, oldest first. */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const MAX_INPUT_HISTORY = 200;

/**
 * Returns a new history array with `line` appended.
 *
 * Blank lines are dropped, and a line identical to the current newest entry is
 * skipped — pressing the same command three times running leaves one entry.
 * Only *consecutive* duplicates collapse; an older occurrence further back is
 * kept, so the sequence of work stays readable when scrolling up.
 */
export function addToInputHistory(history: string[], line: string): string[] {
  if (!line.trim()) return history;
  if (history[history.length - 1] === line) return history;
  const next = [...history, line];
  return next.length > MAX_INPUT_HISTORY ? next.slice(next.length - MAX_INPUT_HISTORY) : next;
}

export const INPUT_HISTORY_FILENAME = 'input-history';

/**
 * One entry per line, so the file stays greppable and hand-editable the way
 * ~/.robin/chats/ is markdown. Backslashes are escaped first so that a prompt
 * containing a literal backslash-n survives the round trip.
 */
export function encodeHistoryLine(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

export function decodeHistoryLine(line: string): string {
  return line.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/**
 * Prompt history that survives a restart, at ~/.robin/input-history.
 *
 * Transcripts of these same conversations are already written to
 * ~/.robin/chats/ after every successful turn, so this adds no new class of
 * exposure — it lives in the same private tree with the same permissions. It
 * does add longevity, which ROBIN_NO_HISTORY_FILE and /history clear exist to
 * control.
 *
 * Every method swallows its errors. A read-only home directory or a full disk
 * must degrade history, never break the prompt.
 */
export class InputHistoryStore {
  constructor(private readonly dir: string = path.join(os.homedir(), '.robin')) {}

  private get filePath(): string {
    return path.join(this.dir, INPUT_HISTORY_FILENAME);
  }

  private get disabled(): boolean {
    return Boolean(process.env.ROBIN_NO_HISTORY_FILE);
  }

  /** Oldest first, capped at MAX_INPUT_HISTORY however long the file is. */
  async load(): Promise<string[]> {
    if (this.disabled) return [];
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const lines = raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map(decodeHistoryLine);
      return lines.length > MAX_INPUT_HISTORY
        ? lines.slice(lines.length - MAX_INPUT_HISTORY)
        : lines;
    } catch {
      return [];
    }
  }

  /**
   * An append, not a rewrite — rewriting 200 lines per submitted prompt would
   * be wasteful. The file is therefore allowed to grow past the cap between
   * runs, and load() trims it back.
   */
  async append(line: string): Promise<void> {
    if (this.disabled || !line.trim()) return;
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.filePath, `${encodeHistoryLine(line)}\n`, { mode: 0o600 });
      // appendFile's `mode` applies only when it creates the file, so a file
      // that already exists with looser permissions would silently keep them.
      if (process.platform !== 'win32') {
        await fs.chmod(this.filePath, 0o600);
      }
    } catch {
      // Deliberately swallowed — see the class comment.
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.filePath, { force: true });
    } catch {
      // Deliberately swallowed.
    }
  }
}
