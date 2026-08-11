import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * What kind of thing is being trusted. Categories are independent: approving a
 * PERSONALITY.md must never imply approving an MCP server that happens to
 * share a key.
 */
export type TrustCategory = 'personality' | 'mcp-server';

export function defaultTrustPath(): string {
  return path.join(os.homedir(), '.robin', 'personality-trust.json');
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * One approval. `hash` present means the user approved that exact content and
 * a change re-prompts; `hash` absent means they approved the key itself and
 * every future version is accepted.
 */
interface TrustGrant {
  hash?: string;
}

type CategoryMap = Record<string, Record<string, TrustGrant>>;

interface TrustFile {
  version: 2;
  categories: CategoryMap;
}

function isGrant(value: unknown): value is TrustGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['string', 'undefined'].includes(typeof (value as TrustGrant).hash);
}

function isGrantMap(value: unknown): value is Record<string, TrustGrant> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isGrant);
}

/**
 * Parses both the current shape and the pre-category one.
 *
 * The discriminator is the explicit `version` field rather than guessing from
 * the shape — a legacy file whose path key happened to be "personality" would
 * otherwise be misread as a category map.
 */
function parseTrustFile(value: unknown): CategoryMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const record = value as Record<string, unknown>;

  if (record.version === 2) {
    const categories = record.categories;
    if (!categories || typeof categories !== 'object' || Array.isArray(categories)) return {};
    const out: CategoryMap = {};
    for (const [category, grants] of Object.entries(categories as Record<string, unknown>)) {
      if (isGrantMap(grants)) out[category] = grants;
    }
    return out;
  }

  // Legacy: a flat key -> grant map, written before categories existed. Every
  // entry in such a file was a PERSONALITY.md approval. Re-prompting for a
  // file the user already approved would be a regression.
  if (isGrantMap(record)) return { personality: record };

  return {};
}

/**
 * Which files and servers the user has agreed to.
 *
 * Both categories gate something that becomes capability: a PERSONALITY.md
 * becomes the system prompt, and an MCP server entry is a command Robin runs.
 * This is the boundary between "it exists on disk" and "a stranger configured
 * your agent".
 *
 * It fails closed — an unreadable or malformed file is treated as empty, so
 * everything re-prompts rather than silently loading.
 */
export class TrustStore {
  constructor(private readonly filePath: string = defaultTrustPath()) {}

  private async read(): Promise<CategoryMap> {
    try {
      return parseTrustFile(JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as unknown);
    } catch {
      return {};
    }
  }

  private async write(categories: CategoryMap): Promise<void> {
    const data: TrustFile = { version: 2, categories };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    // writeFile's `mode` applies only when it creates the file, so a file that
    // already exists with looser permissions would silently keep them.
    if (process.platform !== 'win32') {
      await fs.chmod(this.filePath, 0o600);
    }
  }

  async isTrusted(category: TrustCategory, key: string, content: string): Promise<boolean> {
    const grant = (await this.read())[category]?.[key];
    if (!grant) return false;
    if (grant.hash === undefined) return true;
    return grant.hash === hashContent(content);
  }

  /** Approve this exact content. A change re-prompts. */
  async trustContent(category: TrustCategory, key: string, content: string): Promise<void> {
    await this.grant(category, key, { hash: hashContent(content) });
  }

  /** Approve this key for good, whatever it comes to contain. */
  async trustKey(category: TrustCategory, key: string): Promise<void> {
    await this.grant(category, key, {});
  }

  private async grant(category: TrustCategory, key: string, value: TrustGrant): Promise<void> {
    const categories = await this.read();
    categories[category] = { ...(categories[category] ?? {}), [key]: value };
    await this.write(categories);
  }
}
