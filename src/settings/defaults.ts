/**
 * The stored provider/model pair `robin chat` starts with.
 *
 * Kept apart from cli.ts because this is where the feature actually pays off,
 * and it has rules worth testing: a half-set default is no default, and a
 * provider that has since been removed must fall back to the menu rather than
 * throw. `robin setup` writing a file nobody reads would be the failure mode
 * to avoid; this is the reader.
 */

import type { Provider } from '../providers/types.js';
import type { SettingsStore } from './store.js';

export interface ChatDefault {
  provider: Provider;
  model: string;
}

export async function storedChatDefault(
  store: SettingsStore,
  providers: Provider[],
  warn: (line: string) => void = (line) => console.error(line)
): Promise<ChatDefault | null> {
  const providerId = String(await store.get('default.provider'));
  const model = String(await store.get('default.model'));

  // Half a default cannot start a session, and guessing the other half would
  // be worse than asking.
  if (!providerId || !model) return null;

  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    warn(
      `Your default provider "${providerId}" is not one Robin knows any more — asking instead. ` +
        'Fix it with `robin setup`, or clear it with `robin config unset default.provider`.'
    );
    return null;
  }

  return { provider, model };
}
