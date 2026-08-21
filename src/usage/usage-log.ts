import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { robinHome } from '../profile.js';

export interface UsageEntry {
  ts: string; // ISO 8601
  provider: string; // Provider.id
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** null when this provider/model has no per-token price (Copilot, Ollama, local). */
  estimatedCostUsd: number | null;
}

export function defaultUsageLogPath(): string {
  return path.join(robinHome(), 'usage', 'usage.jsonl');
}

/**
 * Every turn's token cost, one JSON line each. Modeled directly on
 * `AuditLog` (`src/autonomy/audit.ts`): appends are chained on an internal
 * queue so concurrent turns can't interleave partial lines, and a write
 * failure is returned to the caller rather than thrown.
 */
export class UsageLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string = defaultUsageLogPath()) {}

  /** Resolves once every append issued so far has landed. For tests and shutdown. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async append(entry: UsageEntry): Promise<Error | undefined> {
    const write = this.queue.then(async (): Promise<Error | undefined> => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        return undefined;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    });
    this.queue = write;
    return write;
  }

  async readAll(): Promise<UsageEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf-8');
    } catch {
      return [];
    }
    const out: UsageEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageEntry);
      } catch {
        // A truncated final line from an interrupted write must not lose the rest.
      }
    }
    return out;
  }
}
