import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';

export function defaultTrustPath(): string {
  return path.join(os.homedir(), '.robin', 'personality-trust.json');
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * One approval. `hash` present means the user approved that exact text and an
 * edit re-prompts; `hash` absent means they approved the location itself and
 * every future version loads silently.
 */
interface TrustGrant {
  hash?: string;
}

type TrustFile = Record<string, TrustGrant>;

function isTrustFile(value: unknown): value is TrustFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (grant) =>
      Boolean(grant) &&
      typeof grant === 'object' &&
      !Array.isArray(grant) &&
      ['string', 'undefined'].includes(typeof (grant as TrustGrant).hash)
  );
}

/**
 * Which PERSONALITY.md files the user has agreed to load.
 *
 * PERSONALITY.md becomes the system prompt for a tool that can run commands
 * and read files, and it arrives with any repository the user clones. This is
 * the gate between "a file exists" and "a stranger wrote your system prompt".
 *
 * It fails closed: an unreadable or malformed trust file is treated as empty,
 * so every project file re-prompts rather than silently loading.
 */
export class PersonalityTrustStore {
  constructor(private readonly filePath: string = defaultTrustPath()) {}

  private async read(): Promise<TrustFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as unknown;
      return isTrustFile(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private async write(data: TrustFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    // writeFile's `mode` applies only when it creates the file, so a file that
    // already exists with looser permissions would silently keep them.
    if (process.platform !== 'win32') {
      await fs.chmod(this.filePath, 0o600);
    }
  }

  async isTrusted(filePath: string, content: string): Promise<boolean> {
    const grant = (await this.read())[path.resolve(filePath)];
    if (!grant) return false;
    if (grant.hash === undefined) return true;
    return grant.hash === hashContent(content);
  }

  /** Approve this exact text. Editing the file will ask again. */
  async trustContent(filePath: string, content: string): Promise<void> {
    const data = await this.read();
    data[path.resolve(filePath)] = { hash: hashContent(content) };
    await this.write(data);
  }

  /** Approve this location for good, whatever it comes to contain. */
  async trustPath(filePath: string): Promise<void> {
    const data = await this.read();
    data[path.resolve(filePath)] = {};
    await this.write(data);
  }
}
