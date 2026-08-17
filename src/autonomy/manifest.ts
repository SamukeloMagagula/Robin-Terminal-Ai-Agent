import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfirmRequest } from '../tools/execute.js';
import {
  EXECUTING_FLAGS,
  SHELL_CONTROL_PATTERN,
  flagName,
  splitTokens,
} from '../tools/command-safety.js';
import { realPathOrNearest } from '../tools/sensitive-paths.js';

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

function expandHome(pattern: string): string {
  if (pattern === '~') return os.homedir();
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) {
    return path.join(os.homedir(), pattern.slice(2));
  }
  return pattern;
}

const hasWildcard = (segment: string): boolean => segment.includes('*');

/** The fixed prefix of a glob — everything before the first wildcard segment. */
function globPrefix(pattern: string): string {
  const segments = pattern.split(/[\\/]/);
  const at = segments.findIndex(hasWildcard);
  if (at === -1) return pattern;
  return segments.slice(0, at).join(path.sep) || path.sep;
}

/** The wildcard tail, relative to `globPrefix`. */
function globSuffix(pattern: string): string {
  const segments = pattern.split(/[\\/]/);
  const at = segments.findIndex(hasWildcard);
  if (at === -1) return '';
  return segments.slice(at).join(path.sep);
}

/**
 * Glob to RegExp over a resolved absolute path. `**` crosses separators, a
 * single `*` does not. Every other character is escaped, so a pattern cannot
 * smuggle regex syntax through — `a.b` is a literal dot, not "any character".
 */
function globToRegExp(glob: string): RegExp {
  const sep = '[\\\\/]';
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        // Let `root/**/x` match `root/x` as well as `root/a/x`.
        if (glob[i + 1] === '/' || glob[i + 1] === '\\') i += 1;
      } else {
        out += '[^\\\\/]*';
      }
    } else if (char === '/' || char === '\\') {
      out += sep;
    } else {
      out += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Windows paths are case-insensitive; POSIX ones are not, and folding there
  // would quietly widen every rule.
  return new RegExp(`${out}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * Does `pattern` authorise touching `filePath`?
 *
 * Both sides go through realpath first, so a symlink planted inside the root
 * cannot point out of it and `a/../b` cannot climb out. The subject already
 * arrives canonical from execute.ts; resolving again is idempotent and keeps
 * this correct for any other caller.
 */
export async function matchesPath(pattern: string, filePath: string): Promise<boolean> {
  try {
    const expanded = expandHome(pattern);
    const real = await realPathOrNearest(filePath);
    const root = await realPathOrNearest(globPrefix(expanded));
    const suffix = globSuffix(expanded);
    return globToRegExp(suffix ? path.join(root, suffix) : root).test(real);
  } catch {
    return false;
  }
}

/**
 * `server.tool`, with `*` permitted as the tool half only.
 *
 * Trusting a server is already a TrustStore decision; this narrows which of
 * that server's tools an unattended run may reach. There is no case for "any
 * server that happens to offer a tool of this name".
 */
export function matchesMcpTool(pattern: string, name: string): boolean {
  const [patternServer, ...patternRest] = pattern.split('.');
  const [nameServer, ...nameRest] = name.split('.');
  if (!patternServer || patternServer === '*') return false;
  if (patternServer !== nameServer) return false;
  const patternTool = patternRest.join('.');
  const nameTool = nameRest.join('.');
  if (!patternTool || !nameTool) return false;
  return patternTool === '*' || patternTool === nameTool;
}

async function ruleMatches(rule: Rule, request: ConfirmRequest): Promise<boolean> {
  if (rule.kind !== request.kind) return false;
  if (!rule.pattern) return false;
  switch (rule.kind) {
    case 'run_command':
      return matchesCommand(rule.pattern, request.subject);
    case 'read_file':
    case 'write_file':
      return matchesPath(rule.pattern, request.subject);
    case 'mcp_tool':
      return matchesMcpTool(rule.pattern, request.subject);
    default:
      return false;
  }
}

/**
 * Does this manifest permit this request?
 *
 * Never throws: a rule that cannot be evaluated is skipped rather than fatal,
 * so one bad entry cannot revoke the rest. An expiry that will not parse is
 * treated as already past — a date nobody can read is not a grant.
 */
export async function permits(
  manifest: Manifest,
  request: ConfirmRequest,
  now: Date
): Promise<boolean> {
  if (manifest.expires !== null && manifest.expires !== undefined) {
    const deadline = Date.parse(manifest.expires);
    if (Number.isNaN(deadline) || deadline <= now.getTime()) return false;
  }
  for (const rule of manifest.rules) {
    try {
      if (await ruleMatches(rule, request)) return true;
    } catch {
      // Skip this rule only.
    }
  }
  return false;
}
