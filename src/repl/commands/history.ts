import * as path from 'node:path';
import type { ReplContext } from '../repl-context.js';
import { INPUT_HISTORY_FILENAME } from '../input-history.js';
import { mutedColor } from '../../ui/theme.js';
import { robinHome } from '../../profile.js';

export async function handleHistory(ctx: ReplContext, arg?: string): Promise<void> {
  if (arg === 'clear') {
    await ctx.stores.inputHistory.clear();
    ctx.inputHistory.length = 0;
    console.log(mutedColor('Input history cleared.'));
    return;
  }

  if (process.env.ROBIN_NO_HISTORY_FILE) {
    console.log(mutedColor('Input history is session-only (ROBIN_NO_HISTORY_FILE is set).'));
    return;
  }

  const file = path.join(robinHome(), INPUT_HISTORY_FILENAME);
  console.log(mutedColor(`${ctx.inputHistory.length} entries, stored at ${file}`));
  console.log(
    mutedColor('Clear it with /history clear, or set ROBIN_NO_HISTORY_FILE=1 to disable.')
  );
}
