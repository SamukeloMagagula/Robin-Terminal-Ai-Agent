import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { robinHome } from '../profile.js';

/**
 * Remembers models a provider has explicitly rejected as unsupported.
 *
 * Some catalogues advertise models the account cannot actually call — GitHub
 * Copilot lists ~49 chat models where only ~16 are callable, with nothing in
 * the metadata to tell them apart. The rejection is deterministic and
 * per-account, so the only reliable source is having tried once. Recording it
 * means the model is offered once, not every session.
 *
 * Nothing here is a cache of transient failures: only an explicit
 * `model_not_supported` style code is ever recorded.
 */
export function defaultUnsupportedPath(): string {
  return path.join(robinHome(), 'unsupported-models.json');
}

type Stored = Record<string, string[]>;

export class UnsupportedModelStore {
  private cache: Stored | undefined;
  /** What the file looked like when the cache was filled. */
  private cachedStamp: string | undefined;

  constructor(private readonly filePath: string = defaultUnsupportedPath()) {}

  /**
   * Re-reads when another process has touched the file.
   *
   * The gateway holds one of these for its whole life, and `robin models
   * forget` runs in a different process. A cache that never revalidated meant
   * the daemon kept hiding a model the user had just asked it to retry, with
   * nothing on screen to say why.
   */
  private async read(): Promise<Stored> {
    const stamp = await fileStamp(this.filePath);
    if (this.cache && stamp === this.cachedStamp) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      this.cache = isStored(parsed) ? parsed : {};
    } catch {
      // Missing or corrupt: an unusable memo must never block chatting.
      this.cache = {};
    }
    this.cachedStamp = stamp;
    return this.cache;
  }

  async listFor(providerId: string): Promise<string[]> {
    return (await this.read())[providerId] ?? [];
  }

  /** Removes known-unsupported models from a catalogue, preserving order. */
  async filter(providerId: string, models: string[]): Promise<string[]> {
    const unsupported = new Set(await this.listFor(providerId));
    return models.filter((model) => !unsupported.has(model));
  }

  async record(providerId: string, model: string): Promise<void> {
    const data = await this.read();
    const existing = data[providerId] ?? [];
    if (existing.includes(model)) return;
    data[providerId] = [...existing, model];
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Best-effort: failing to persist costs one repeated prompt, not the turn.
    }
  }

  /** Forgets everything recorded for a provider, so its catalogue is retried. */
  async clear(providerId: string): Promise<void> {
    const data = await this.read();
    if (!data[providerId]) return;
    delete data[providerId];
    try {
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // As above.
    }
  }
}

/**
 * A cheap identity for the file's current contents.
 *
 * Size and mtime together, because mtime alone has a coarse resolution on some
 * filesystems and two writes inside the same tick would look identical.
 * Undefined means the file is not there — itself a state worth noticing, since
 * a file that appears later is new information.
 */
export async function fileStamp(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function isStored(value: unknown): value is Stored {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((m) => typeof m === 'string')
  );
}
