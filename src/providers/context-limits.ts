import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileStamp } from './unsupported-models.js';
import { robinHome } from '../profile.js';

export function defaultContextLimitsPath(): string {
  return path.join(robinHome(), 'context-limits.json');
}

type Stored = Record<string, Record<string, number>>;

/**
 * Context limits, learned from the providers that enforced them.
 *
 * There is no catalogue to read these from. Model listings do not carry a
 * context window, the same model name can be served with different windows on
 * different plans, and a hardcoded table would be wrong the week after it was
 * written. What is reliable is the refusal itself: a provider that rejects a
 * prompt for being too long usually says what the limit was, and that limit
 * holds for the next turn.
 *
 * Remembering it turns a failure into a budget — the first oversized turn
 * costs one rejected request, and every later turn on that model is trimmed to
 * fit before it is sent.
 */
export class ContextLimitStore {
  private cache: Stored | undefined;
  /** What the file looked like when the cache was filled. */
  private cachedStamp: string | undefined;

  constructor(private readonly filePath: string = defaultContextLimitsPath()) {}

  /**
   * Re-reads when another process has touched the file. The gateway holds one
   * of these for its whole life; see UnsupportedModelStore for the full story.
   */
  private async read(): Promise<Stored> {
    const stamp = await fileStamp(this.filePath);
    if (this.cache && stamp === this.cachedStamp) return this.cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as unknown;
      this.cache = isStored(parsed) ? parsed : {};
    } catch {
      // Missing or corrupt: an unusable memo must never block chatting.
      this.cache = {};
    }
    this.cachedStamp = stamp;
    return this.cache;
  }

  async get(providerId: string, model: string): Promise<number | undefined> {
    return (await this.read())[providerId]?.[model];
  }

  /**
   * Records a limit, keeping the smaller of the two when one is already known.
   *
   * Smaller wins because the evidence is asymmetric: a rejection proves a
   * prompt of that size does not fit, while nothing here ever proves a larger
   * one does. Raising the number on a later, vaguer error would undo a limit
   * that was measured.
   */
  async record(providerId: string, model: string, limit: number): Promise<void> {
    if (!Number.isFinite(limit) || limit < 512) return;
    const data = await this.read();
    const known = data[providerId]?.[model];
    const next = known === undefined ? limit : Math.min(known, limit);
    if (known === next) return;
    data[providerId] = { ...(data[providerId] ?? {}), [model]: next };
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Best-effort: failing to persist costs one rejected request, not the turn.
    }
  }
}

function isStored(value: unknown): value is Stored {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (models) =>
      !!models &&
      typeof models === 'object' &&
      !Array.isArray(models) &&
      Object.values(models as Record<string, unknown>).every((n) => typeof n === 'number')
  );
}
