import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type MemoryType = 'user' | 'project' | 'reference';

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/** What the index carries: enough to decide whether to read the body. */
export type MemoryMeta = Omit<Memory, 'body'>;

/**
 * Only the index and the profile are sent with every turn, so both are capped.
 * Loading every memory body would grow the prompt without limit until a
 * long-running user paid for their entire history on each request.
 */
export const MAX_INDEX_BYTES = 8 * 1024;
export const MAX_PROFILE_BYTES = 4 * 1024;

export const PROFILE_FILE = 'profile.md';

export function defaultMemoryDir(): string {
  return path.join(os.homedir(), '.robin', 'memory');
}

/** Slot names to filesystem-safe basenames, as the other stores do. */
export function isValidMemoryName(name: string): boolean {
  if (name === '.' || name === '..') return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

const VALID_TYPES = new Set<MemoryType>(['user', 'project', 'reference']);

/**
 * Memories the model has chosen to keep, one markdown file each.
 *
 * Plain files rather than a database, for the same reason transcripts are
 * markdown: they can be read, grepped, edited and deleted without Robin's
 * help. What the model writes about you should not need a tool to inspect.
 *
 * Every read tolerates a missing or broken directory — memory degrading is
 * never a reason for the prompt to fail.
 */
export class MemoryStore {
  constructor(private readonly dir: string = defaultMemoryDir()) {}

  private pathFor(name: string): string {
    return path.join(this.dir, `${name}.md`);
  }

  /**
   * Every memory, in creation order.
   *
   * Order comes from the filesystem listing, which is stable, rather than from
   * mtime: editing a memory must not reorder it, or index eviction would drift
   * every time a file was touched.
   */
  async list(): Promise<MemoryMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const out: MemoryMeta[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md') || entry === PROFILE_FILE) continue;
      const name = entry.slice(0, -'.md'.length);
      const memory = await this.read(name);
      // A hand-edited file with broken frontmatter costs one entry, not the
      // whole list.
      if (memory) out.push({ name: memory.name, description: memory.description, type: memory.type });
    }
    return out;
  }

  async read(name: string): Promise<Memory | undefined> {
    if (!isValidMemoryName(name)) return undefined;
    let raw: string;
    try {
      raw = await fs.readFile(this.pathFor(name), 'utf-8');
    } catch {
      return undefined;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) return undefined;
    return {
      name,
      description: parsed.fields.description ?? '',
      type: VALID_TYPES.has(parsed.fields.type as MemoryType)
        ? (parsed.fields.type as MemoryType)
        : 'reference',
      body: parsed.body,
    };
  }

  /** Creates, or replaces an existing memory of the same name. */
  async write(memory: Memory): Promise<void> {
    if (!isValidMemoryName(memory.name)) {
      throw new Error(
        `Invalid memory name "${memory.name}" — use letters, numbers, dots, dashes, underscores only.`
      );
    }
    const contents = [
      '---',
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      '---',
      '',
      memory.body,
      '',
    ].join('\n');

    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.pathFor(memory.name), contents, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await fs.chmod(this.pathFor(memory.name), 0o600);
    }
  }

  async forget(name: string): Promise<boolean> {
    if (!isValidMemoryName(name)) return false;
    try {
      await fs.unlink(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One line per memory, for the system prompt.
   *
   * Over the cap, the oldest-created lines are dropped **from the prompt
   * only** — never from disk. Not modification time: updating a memory would
   * otherwise push it to the front and evict something more important.
   */
  async index(): Promise<string> {
    const all = await this.list();
    if (all.length === 0) return '';

    const lines = all.map((m) => `- ${m.name} (${m.type}) — ${m.description}`);

    // Drop from the front until it fits, so the newest survive.
    let start = 0;
    while (start < lines.length && lines.slice(start).join('\n').length > MAX_INDEX_BYTES) {
      start++;
    }
    return lines.slice(start).join('\n');
  }

  /** The accumulating model of the user. Small enough to always send in full. */
  async profile(): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.dir, PROFILE_FILE), 'utf-8');
      return raw.length > MAX_PROFILE_BYTES ? raw.slice(0, MAX_PROFILE_BYTES) : raw;
    } catch {
      return undefined;
    }
  }
}

/**
 * A deliberately small frontmatter reader: `key: value` lines between `---`
 * fences. Memories are written by Robin and hand-edited by the user, so a full
 * YAML parser would be a dependency bought for nothing.
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } | undefined {
  const normalised = raw.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) return undefined;
  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return undefined;

  const fields: Record<string, string> = {};
  for (const line of normalised.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const body = normalised.slice(end + '\n---'.length).replace(/^\n+/, '').trimEnd();
  return { fields, body };
}
