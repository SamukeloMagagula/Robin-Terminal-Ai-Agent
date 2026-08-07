import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
  return path.join(os.homedir(), '.robin', 'unsupported-models.json');
}

type Stored = Record<string, string[]>;

export class UnsupportedModelStore {
  private cache: Stored | undefined;

  constructor(private readonly filePath: string = defaultUnsupportedPath()) {}

  private async read(): Promise<Stored> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      this.cache = isStored(parsed) ? parsed : {};
    } catch {
      // Missing or corrupt: an unusable memo must never block chatting.
      this.cache = {};
    }
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

function isStored(value: unknown): value is Stored {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((m) => typeof m === 'string')
  );
}
