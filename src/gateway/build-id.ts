import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where this module was compiled to — the root of the build it belongs to. */
function defaultBuildDir(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/**
 * Only ever the real build's fingerprint.
 *
 * A process's own compiled output cannot change under it in any way that
 * matters, and this is asked on every connect. A caller naming a directory is
 * asking about something else, and gets a fresh answer.
 */
let cachedOwn: string | undefined | 'unset' = 'unset';

/**
 * A short identifier for the compiled output a process is running.
 *
 * The gateway outlives the build that started it. `robin gateway stop` after a
 * rebuild is easy to forget, and a daemon running yesterday's code does not
 * announce itself — it just behaves like yesterday's code. That cost real
 * confusion once: token counting looked broken for a request served by a
 * daemon that predated it.
 *
 * The protocol version already refuses a client that cannot be understood.
 * This is the softer case, and much more common: same protocol, different
 * code. It warns rather than refuses, because most rebuilds change nothing a
 * running daemon would get wrong, and refusing on every edit would be worse
 * than the problem.
 *
 * Size and mtime of every emitted .js, hashed. Not the file contents: this
 * runs at startup and on every connect, and reading a whole build to answer a
 * question about staleness is more work than the answer is worth.
 */
export async function buildFingerprint(dir?: string): Promise<string | undefined> {
  return fingerprint(dir);
}

/**
 * The build on disk right now, ignoring what this process started with.
 *
 * The cached version answers "what am I running", which cannot change. This
 * answers "has the build moved underneath me", which is the question a daemon
 * has to ask about itself — a browser cannot compute a fingerprint, so it
 * cannot be the one to notice.
 */
export async function freshBuildFingerprint(): Promise<string | undefined> {
  // Naming the directory means this is not treated as "our own" build, so it
  // neither reads nor writes the cache. That is the point: the cached value
  // must keep saying what this process is running, which has not changed.
  return fingerprint(defaultBuildDir());
}

async function fingerprint(dir?: string): Promise<string | undefined> {
  const own = dir === undefined;
  if (own && cachedOwn !== 'unset') return cachedOwn;

  const root = dir ?? defaultBuildDir();
  const parts: string[] = [];
  try {
    await collect(root, root, parts);
  } catch {
    // Cannot tell must never become cannot run.
    if (own) cachedOwn = undefined;
    return undefined;
  }
  if (parts.length === 0) {
    if (own) cachedOwn = undefined;
    return undefined;
  }

  parts.sort();
  const digest = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
  if (own) cachedOwn = digest;
  return digest;
}

async function collect(root: string, dir: string, parts: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(root, full, parts);
      continue;
    }
    // Source maps and declarations change with the build but say nothing about
    // what the code does, and .txt/.json alongside it are not the build at all.
    if (!entry.name.endsWith('.js')) continue;
    const stat = await fs.stat(full);
    parts.push(`${path.relative(root, full).replace(/\\/g, '/')}:${stat.size}:${stat.mtimeMs}`);
  }
}
