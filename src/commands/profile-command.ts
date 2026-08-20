/**
 * `robin profile list` — what ROBIN_PROFILE can be set to, and which one is
 * currently active.
 *
 * Profiles are never created by a command — the first store that gets used
 * under a new ROBIN_PROFILE creates its own directory, the same way ~/.robin
 * itself has always come into existence on first run. This command only
 * looks at what already exists.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';

export interface ProfileListOptions {
  profilesDir?: string;
  /** The name ROBIN_PROFILE names, or undefined for the default profile. */
  currentProfile?: string;
  out: (line: string) => void;
}

function defaultProfilesDir(): string {
  return path.join(os.homedir(), '.robin-profiles');
}

export async function runProfileList(options: ProfileListOptions): Promise<void> {
  const profilesDir = options.profilesDir ?? defaultProfilesDir();
  const current = options.currentProfile;

  let named: string[] = [];
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    named = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    // No profiles directory yet — only the default profile exists.
  }

  options.out(`default${current === undefined ? '  (current)' : ''}`);
  for (const name of named) {
    options.out(`${name}${current === name ? '  (current)' : ''}`);
  }
  // ROBIN_PROFILE can name a profile that has never actually been used — no
  // store has written anything under it yet, so it has no directory. It is
  // still the current profile and would be created on first use, so it must
  // still show up rather than silently vanishing from the list.
  if (current !== undefined && !named.includes(current)) {
    options.out(`${current}  (current, not yet used)`);
  }
}
