import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Manifest, Rule } from './manifest.js';

export function defaultAutonomyPath(): string {
  return path.join(os.homedir(), '.robin', 'autonomy.json');
}

type StoredManifest = Omit<Manifest, 'id'>;

interface AutonomyFile {
  version: 1;
  manifests: Record<string, StoredManifest>;
}

function isRule(value: unknown): value is Rule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Rule;
  return typeof rule.kind === 'string' && typeof rule.pattern === 'string';
}

function isStoredManifest(value: unknown): value is StoredManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as StoredManifest;
  if (typeof manifest.created !== 'string') return false;
  if (!Array.isArray(manifest.rules)) return false;
  if (manifest.expires !== null && typeof manifest.expires !== 'string') return false;
  return manifest.rules.every(isRule);
}

/**
 * Which manifests a human has approved.
 *
 * Fails closed, for the reason TrustStore does: an unreadable or malformed file
 * is treated as empty, so every manifest stops granting rather than one being
 * misparsed into granting something nobody agreed to. A manifest whose rules
 * are the wrong shape is dropped on its own — the others are still readable,
 * and refusing all of them over one bad entry would be its own failure.
 *
 * The `version` discriminator is explicit rather than inferred from shape.
 */
export class AutonomyStore {
  /**
   * Writes in flight, chained, with reads queued behind them.
   *
   * An approval answered with 'manifest' scope adds a rule and returns without
   * waiting; the next tool request then reads the manifest back. Left
   * unordered, that read can overtake the write and re-ask about the very
   * thing just approved. Ordering it here rather than in the caller is what
   * makes it hold across two readers of the same file — and it is the same
   * reason AuditLog serialises its appends.
   *
   * Rejections are swallowed on the chain only, so one failed write cannot
   * poison every operation after it; the caller still sees its own error.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string = defaultAutonomyPath()) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Record<string, StoredManifest>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const file = parsed as Partial<AutonomyFile>;
      if (file.version !== 1) return {};
      const { manifests } = file;
      if (!manifests || typeof manifests !== 'object' || Array.isArray(manifests)) return {};
      const out: Record<string, StoredManifest> = {};
      for (const [id, manifest] of Object.entries(manifests)) {
        if (isStoredManifest(manifest)) out[id] = manifest;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async write(manifests: Record<string, StoredManifest>): Promise<void> {
    const data: AutonomyFile = { version: 1, manifests };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    // `mode` applies only when writeFile creates the file, so one that already
    // exists would otherwise keep whatever looser permissions it had.
    if (process.platform !== 'win32') {
      await fs.chmod(this.filePath, 0o600);
    }
  }

  async get(id: string): Promise<Manifest | undefined> {
    await this.queue.catch(() => undefined);
    const found = (await this.read())[id];
    return found ? { id, ...found } : undefined;
  }

  async list(): Promise<Manifest[]> {
    await this.queue.catch(() => undefined);
    return Object.entries(await this.read()).map(([id, manifest]) => ({ id, ...manifest }));
  }

  async put(manifest: Manifest): Promise<void> {
    return this.enqueue(async () => {
      const { id, ...rest } = manifest;
      const manifests = await this.read();
      manifests[id] = rest;
      await this.write(manifests);
    });
  }

  /**
   * Revokes a manifest. Returns false when there was nothing to revoke.
   *
   * Sessions consult the store on every request rather than holding a copy,
   * so this takes effect immediately — including for a session already
   * running unattended, which is the case revocation exists for.
   */
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const manifests = await this.read();
      if (!(id in manifests)) return false;
      delete manifests[id];
      await this.write(manifests);
      return true;
    });
  }

  /** Returns false when the manifest does not exist. An identical rule is a no-op. */
  async addRule(id: string, rule: Rule): Promise<boolean> {
    return this.enqueue(async () => {
      const manifests = await this.read();
      const existing = manifests[id];
      if (!existing) return false;
      const duplicate = existing.rules.some(
        (candidate) => candidate.kind === rule.kind && candidate.pattern === rule.pattern
      );
      if (!duplicate) {
        manifests[id] = { ...existing, rules: [...existing.rules, rule] };
        await this.write(manifests);
      }
      return true;
    });
  }
}
