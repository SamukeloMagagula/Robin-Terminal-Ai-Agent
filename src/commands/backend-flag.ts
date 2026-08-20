import type { BackendConfig } from '../backends/types.js';
import { UserFacingError } from '../startup/bootstrap.js';

/**
 * Parses `--backend <spec>` for `robin chat`, e.g. `docker:node:20`.
 *
 * No default image, and no silent fallback to local for an unrecognized
 * kind — either is a guess that would make a later command fail with no
 * obvious cause. A missing or unrecognized backend fails clearly, here,
 * before any session is created.
 */
export function parseBackendFlag(spec: string): BackendConfig {
  const separator = spec.indexOf(':');
  const kind = separator === -1 ? spec : spec.slice(0, separator);
  const rest = separator === -1 ? '' : spec.slice(separator + 1);

  if (kind !== 'docker') {
    throw new UserFacingError(
      `Unknown execution backend "${kind}". Only "docker" is supported today — pass --backend docker:<image>.`
    );
  }
  if (!rest.trim()) {
    throw new UserFacingError(
      '--backend docker needs an image, e.g. --backend docker:node:20. There is no default — a guessed ' +
        'image would make later commands fail for a reason that would not be obvious.'
    );
  }
  return { kind: 'docker', image: rest };
}
