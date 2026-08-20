import * as path from 'node:path';
import * as os from 'node:os';
import { UserFacingError } from './startup/bootstrap.js';

/**
 * Where Robin's own files live — one directory per profile.
 *
 * The default (no `ROBIN_PROFILE` set) is bare `~/.robin`, unchanged from
 * before profiles existed, so an existing install needs no migration. A
 * named profile gets its own sibling directory under `~/.robin-profiles/`
 * rather than nesting inside `~/.robin` — the default profile's files and
 * every other profile's directory would otherwise sit side by side in the
 * same tree, which is more to explain for no real benefit.
 *
 * Every one of Robin's own stores (auth, memory, skills, settings, the
 * gateway's own discovery file, …) resolves its default path through this
 * function, so switching `ROBIN_PROFILE` switches all of them together —
 * including the gateway daemon itself: it is spawned as a child process with
 * no explicit `env` override, so it inherits `ROBIN_PROFILE` from whatever
 * spawned it, and ends up reading and writing its own separate
 * `gateway.json` under the same profile directory. No extra wiring needed
 * for the daemon to become profile-aware — inheriting the environment
 * variable is enough.
 */
export function robinHome(): string {
  const profile = process.env.ROBIN_PROFILE?.trim();
  if (!profile) return path.join(os.homedir(), '.robin');

  if (!isValidProfileName(profile)) {
    throw new UserFacingError(
      `"${profile}" is not a usable ROBIN_PROFILE name. Use letters, numbers, dot, dash and underscore.`
    );
  }
  return path.join(os.homedir(), '.robin-profiles', profile);
}

export function isValidProfileName(name: string): boolean {
  if (name === '.' || name === '..') return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}
