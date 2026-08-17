import type { ConfirmRequest } from '../tools/execute.js';
import {
  EXECUTING_FLAGS,
  SHELL_CONTROL_PATTERN,
  flagName,
  splitTokens,
} from '../tools/command-safety.js';

/**
 * Derived rather than restated, so a new kind added to execute.ts cannot
 * silently become a kind no manifest is able to express.
 */
export type RuleKind = ConfirmRequest['kind'];

export interface Rule {
  kind: RuleKind;
  pattern: string;
}

export interface Escalation {
  surface: string;
  windowMinutes: number;
}

export interface Manifest {
  id: string;
  created: string;
  rules: Rule[];
  expires: string | null;
  escalate?: Escalation;
}

/**
 * Flags that turn an otherwise-matching executable into an arbitrary-code
 * runner.
 *
 * Keyed per executable, not global: `-c` makes git run a pager of the caller's
 * choosing, but is an ordinary flag to docker and tar, and a global denylist
 * would refuse commands it has no business refusing.
 */
export const MANIFEST_DENIED_FLAGS = new Map<string, Set<string>>([
  [
    'git',
    new Set([
      '-c',
      '--exec-path',
      '--upload-pack',
      '--receive-pack',
      '--pager',
      '--ssh-command',
    ]),
  ],
  ['ssh', new Set(['-o', 'proxycommand', '-f'])],
  ['find', new Set(['-exec', '-execdir', '-delete'])],
]);

const foldCase = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;

/**
 * Positional token match. A bare `*` matches exactly one token; a trailing `*`
 * takes the rest, including nothing.
 */
function matchTokens(pattern: string[], actual: string[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '*' && i === pattern.length - 1) return true;
    if (i >= actual.length) return false;
    if (pattern[i] === '*') continue;
    if (pattern[i] !== actual[i]) return false;
  }
  return pattern.length === actual.length;
}

/**
 * Does `pattern` authorise `command`?
 *
 * A manifest entry authorises one process, never a shell script — which is why
 * a metacharacter anywhere is refused outright rather than escaped. Every check
 * below fails toward refusing, for the reason command-safety.ts gives: a false
 * negative costs one refused call, a false positive runs something destructive
 * with nobody watching.
 */
export function matchesCommand(pattern: string, command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_CONTROL_PATTERN.test(trimmed)) return false;

  const tokens = splitTokens(trimmed);
  const patternTokens = splitTokens(pattern.trim());
  if (tokens.length === 0 || patternTokens.length === 0) return false;

  // flagName, not the raw token: `--output=/etc/x` and `--output /etc/x` are
  // the same flag and must be refused alike.
  if (tokens.some((token) => EXECUTING_FLAGS.has(flagName(token)))) return false;

  if (foldCase(tokens[0]) !== foldCase(patternTokens[0])) return false;

  const denied = MANIFEST_DENIED_FLAGS.get(patternTokens[0].toLowerCase());
  if (denied && tokens.some((token) => denied.has(flagName(token)))) return false;

  return matchTokens(patternTokens.slice(1), tokens.slice(1));
}
