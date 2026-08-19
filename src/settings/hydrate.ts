/**
 * Publishes stored settings into the environment, once, at startup.
 *
 * Five settings correspond to variables that predate settings.json, read
 * directly and synchronously by the modules that care (the gateway's port,
 * the browser command, the debug flag, the history flag, the local base URL).
 * Rewriting all five to await a store would spread async through call sites
 * that have no other reason to have it — and would risk the file being read
 * at a different moment in each one.
 *
 * So the file is read once and any variable that is *not already set* is
 * filled in from it. That gives the design's precedence for free: a variable
 * exported in a shell is never overwritten, so the environment still outranks
 * the file, and every existing reader keeps working untouched.
 *
 * Only variables Robin owns are ever written.
 */

import type { SettingsStore } from './store.js';

export async function hydrateEnv(
  store: SettingsStore,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const resolved = await store.resolveAll();

  for (const { setting, value, source } of resolved) {
    if (!setting.envVar) continue;
    // Only the file is worth publishing: 'env' is already there by definition,
    // and 'default' is what every reader falls back to on its own.
    if (source !== 'file') continue;
    if (env[setting.envVar] !== undefined) continue;

    if (setting.type === 'boolean') {
      // A flag variable carries meaning by existing at all, so the only way to
      // say "off" is to leave it absent.
      const shouldSet = setting.invertEnv ? value === false : value === true;
      if (shouldSet) env[setting.envVar] = '1';
      continue;
    }

    const text = String(value);
    if (text) env[setting.envVar] = text;
  }
}
