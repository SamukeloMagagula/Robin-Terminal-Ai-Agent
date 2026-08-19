import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { defaultAuthPath } from '../auth-store.js';

/**
 * Directories read_file/write_file refuse to touch. Robin's own credentials
 * and SSH keys were the original two; the rest are the standard places a
 * developer machine keeps long-lived tokens, and are exactly what a
 * prompt-injected model would go looking for.
 */
export function defaultSensitiveDirs(): string[] {
  const home = os.homedir();
  return [
    path.dirname(defaultAuthPath()),
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.kube'),
    path.join(home, '.docker'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, 'AppData', 'Roaming', 'gcloud'),
  ];
}

/** Basenames that hold credentials wherever they happen to live. */
const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

export function isSensitiveBasename(filePath: string): boolean {
  return SENSITIVE_BASENAMES.has(path.basename(filePath).toLowerCase());
}

/**
 * True when `filePath` resolves to something inside `directory` (or is the
 * directory itself). Both sides are resolved first, so `a/../b` cannot escape.
 */
export function isInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedDir = path.resolve(directory);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile === resolvedDir) return true;
  const relative = path.relative(resolvedDir, resolvedFile);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function isInsideAnyDirectory(filePath: string, directories: string[]): boolean {
  return directories.some((dir) => isInsideDirectory(filePath, dir));
}

/**
 * path.resolve() collapses `..` lexically but does NOT follow symlinks, so a
 * link planted at ./notes -> ~/.ssh/id_rsa would sail through a guard built on
 * resolve() alone. Resolve the real path first, walking up to the nearest
 * existing ancestor when the target itself does not exist yet (the write case).
 */
export async function realPathOrNearest(filePath: string): Promise<string> {
  let current = path.resolve(filePath);
  const trailing: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      // Hit the filesystem root without finding anything that exists.
      if (parent === current) return path.resolve(filePath);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Splits a shell command into argv-style tokens, honouring single and double
 * quotes so a quoted argument containing whitespace — `cat "my secrets/id_rsa"`
 * — survives as one token instead of being torn apart by a bare whitespace
 * split, which would mangle the path past recognition and let it slip by
 * undetected. Not a full shell grammar (no nested quotes, no backslash
 * escapes) — good enough to recover the arguments a real shell would pass.
 */
function splitCommandTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/**
 * A token from a shell command that could plausibly be a path argument: any
 * non-flag token, including a bare filename a command might read. Flags like
 * `-n` or `--output=x` are skipped — this is about the thing the command
 * touches, not how it was asked to touch it. Deliberately broad rather than
 * narrow: a non-path token like a numeric argument just resolves to nothing
 * sensitive and costs one wasted lookup, whereas narrowing this and missing a
 * real path is the failure mode that matters here.
 */
function looksLikePathToken(token: string): boolean {
  return !token.startsWith('-');
}

function expandHome(token: string): string {
  if (token === '~') return os.homedir();
  if (token.startsWith('~/') || token.startsWith('~\\')) {
    return path.join(os.homedir(), token.slice(2));
  }
  return token;
}

/**
 * Whether a shell command references a protected credential location in any
 * of its arguments — `run_command` has no single structured path the way
 * `read_file`/`write_file` do, so this scans tokens heuristically rather than
 * refusing outright. Returns the real path found, or undefined.
 */
export async function commandTouchesSensitivePath(
  command: string,
  cwd: string = process.cwd(),
  sensitiveDirs: string[] = defaultSensitiveDirs()
): Promise<string | undefined> {
  const tokens = splitCommandTokens(command).slice(1);
  const realDirs = await Promise.all(sensitiveDirs.map((dir) => realPathOrNearest(dir)));

  for (const raw of tokens) {
    if (!looksLikePathToken(raw)) continue;
    const candidate = expandHome(raw);
    const realPath = await realPathOrNearest(path.resolve(cwd, candidate));
    if (isInsideAnyDirectory(realPath, realDirs) || isSensitiveBasename(realPath)) {
      return realPath;
    }
  }
  return undefined;
}

export interface PathVerdict {
  blocked: boolean;
  /** Ready-to-print refusal, phrased for the verb that triggered the check. */
  refusal?: string;
  realPath: string;
}

/** Single decision point for "may a file tool touch this path at all?". */
export async function checkPath(
  filePath: string,
  verb: 'read' | 'write',
  sensitiveDirs: string[] = defaultSensitiveDirs()
): Promise<PathVerdict> {
  const realPath = await realPathOrNearest(filePath);
  // Both sides must be canonical or the comparison is meaningless: Windows
  // hands out 8.3 short paths (C:\Users\SAMUKE~1.MAG\...) for the same
  // directory the long form names, and either side may be a symlink.
  const realDirs = await Promise.all(sensitiveDirs.map((dir) => realPathOrNearest(dir)));
  if (isInsideAnyDirectory(realPath, realDirs)) {
    return {
      blocked: true,
      refusal:
        verb === 'read'
          ? 'refused to read from a protected credential directory'
          : 'refused to write inside a protected credential directory',
      realPath,
    };
  }
  if (isSensitiveBasename(realPath)) {
    const name = path.basename(realPath);
    return {
      blocked: true,
      refusal:
        verb === 'read'
          ? `refused to read a protected credential file (${name})`
          : `refused to write to a protected credential file (${name})`,
      realPath,
    };
  }
  return { blocked: false, realPath };
}
