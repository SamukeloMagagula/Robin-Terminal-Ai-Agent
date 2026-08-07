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
