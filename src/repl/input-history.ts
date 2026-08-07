/** Lines the user has submitted this session, oldest first. Never written to disk. */

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
